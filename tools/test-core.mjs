import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const ACH = require('../js/core.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleText = readFileSync(join(root, 'samples', 'payroll.ach'), 'utf8');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (err) {
    console.error('FAIL - ' + name);
    throw err;
  }
}

function rec(kind, values = {}) {
  const record = ACH.createRecord(kind);
  Object.assign(record.fields, values);
  return record;
}

function fieldLengths() {
  const out = {};
  Object.entries(ACH.FIELD_DEFS).forEach(([kind, defs]) => {
    out[kind] = defs.reduce((sum, def) => sum + def.length, 0);
    assert.equal(out[kind], 94, kind + ' field lengths total ' + out[kind]);
    let expectedStart = 1;
    defs.forEach((def) => {
      assert.equal(def.start, expectedStart, kind + '.' + def.key + ' starts at ' + def.start + ', expected ' + expectedStart);
      expectedStart += def.length;
    });
  });
  return out;
}

test('every record layout is exactly 94 characters with contiguous fields', () => {
  fieldLengths();
});

test('sample parses into the expected structure and totals', () => {
  const { doc, issues } = ACH.parseFile(sampleText);
  assert.equal(issues.length, 0);
  assert.equal(doc.batches.length, 2);
  assert.equal(doc.batches[0].entries.length, 2);
  assert.equal(doc.batches[0].entries[1].addenda.length, 1);
  assert.equal(doc.batches[1].entries.length, 2);
  assert.equal(doc.padding, 9);
  assert.equal(doc.fileHeader.fields.immediateDestination, ' 231380104');

  const computed = ACH.computeTotals(doc);
  assert.equal(computed.file.batchCount, 2);
  assert.equal(computed.file.entryAddendaCount, 5);
  assert.equal(computed.file.entryHash, 46438037);
  assert.equal(computed.file.debit, 134049);
  assert.equal(computed.file.credit, 435075);
  assert.equal(computed.file.blockCount, 2);
  assert.equal(computed.file.padding, 9);
  assert.equal(computed.batches[0].entryHash, 25238012);
  assert.equal(computed.batches[1].entryHash, 21200025);
});

test('sample round-trips byte for byte', () => {
  const { doc } = ACH.parseFile(sampleText);
  const lineEnding = sampleText.includes('\r\n') ? '\r\n' : '\n';
  const rebuilt = ACH.buildFile(doc, {
    applyComputed: true,
    lineEnding,
    finalNewline: sampleText.endsWith('\n')
  });
  assert.equal(rebuilt, sampleText);
});

test('rebuild without recalculating preserves control values', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.fileControl.fields.batchCount = '000009';
  const rebuilt = ACH.buildFile(doc, { applyComputed: false, lineEnding: '\n', finalNewline: false });
  assert.equal(rebuilt, sampleText.replace(/\r\n/g, '\n').replace(/00000200000200000005/, '00000900000200000005').trimEnd());
});

test('editing an amount updates batch and file control totals', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.batches[0].entries[0].detail.fields.amount = '0000300000';
  ACH.applyComputed(doc);
  assert.equal(doc.batches[0].control.fields.totalCreditEntryDollarAmount, '000000485075');
  assert.equal(doc.fileControl.fields.totalCreditEntryDollarAmount, '000000485075');
  assert.equal(doc.batches[0].control.fields.entryHash, '0025238012');

  const text = ACH.buildFile(doc, { lineEnding: '\r\n', finalNewline: true });
  const parsed = ACH.parseFile(text);
  assert.equal(parsed.doc.batches[0].entries[0].detail.fields.amount, '0000300000');
  assert.equal(parsed.doc.fileControl.fields.totalCreditEntryDollarAmount, '000000485075');
});

test('stale control values are flagged when auto-fix is off', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.batches[1].control.fields.entryHash = '0000000000';
  const issues = ACH.validate(doc, { autoFix: false });
  assert.ok(issues.some((i) => i.path === 'b1.c.entryHash' && i.severity === 'warning'));
  const fixed = ACH.validate(doc, { autoFix: true });
  assert.ok(!fixed.some((i) => i.path === 'b1.c.entryHash'));
});

test('stale controls are detected by compareComputed', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.fileControl.fields.entryHash = '0000000001';
  const result = ACH.compareComputed(doc);
  const paths = result.mismatches.map((m) => m.path);
  assert.ok(paths.includes('fc.entryHash'));
  const computed = ACH.computeTotals(doc);
  assert.equal(result.mismatches.length, 1);
  assert.equal(computed.file.entryHash, 46438037);
});

test('validation catches routing check digit errors', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.batches[0].entries[0].detail.fields.checkDigit = '9';
  const issues = ACH.validate(doc, { autoFix: true });
  assert.ok(issues.some((i) => i.path === 'b0.e0.d.checkDigit' && i.severity === 'error'));
});

test('validation catches service class conflicts', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.batches[0].header.fields.serviceClassCode = '225';
  const issues = ACH.validate(doc, { autoFix: true });
  assert.ok(issues.some((i) => i.path === 'b0.h.serviceClassCode' && i.severity === 'error'));
});

test('validation catches prenote amounts', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.batches[0].entries[0].detail.fields.transactionCode = '23';
  const issues = ACH.validate(doc, { autoFix: true });
  assert.ok(issues.some((i) => i.path === 'b0.e0.d.amount' && i.severity === 'error'));
});

test('check digit helper matches known routing numbers', () => {
  assert.equal(ACH.calculatedCheckDigit('23138010'), 4);
  assert.equal(ACH.calculatedCheckDigit('02100002'), 1);
  assert.equal(ACH.calculatedCheckDigit('09100001'), 9);
  assert.equal(ACH.calculatedCheckDigit('12100024'), 8);
  assert.equal(ACH.calculatedCheckDigit('1234'), null);
  assert.deepEqual(ACH.routingWithCheckDigit('23138010', '4'), { computed: 4, actual: 4, valid: true });
});

test('addenda 98 (notification of change) round-trips', () => {
  const doc = {
    fileHeader: rec('fileHeader', {
      priorityCode: '01',
      immediateDestination: ' 231380104',
      immediateOrigin: ' 123456789',
      fileCreationDate: '261105',
      fileCreationTime: '1200',
      fileIDModifier: 'A',
      immediateDestinationName: 'ACME BANK',
      immediateOriginName: 'ACME PAYROLL',
      referenceCode: 'NOC1'
    }),
    batches: [{
      header: rec('batchHeader', {
        serviceClassCode: '200',
        companyName: 'ACME PAYROLL INC',
        companyIdentification: '1234567890',
        standardEntryClassCode: 'COR',
        companyEntryDescription: 'CORRECT',
        effectiveEntryDate: '261106',
        originatorStatusCode: '1',
        originatingDFIIdentification: '12345678',
        batchNumber: '0000001'
      }),
      entries: [{
        detail: rec('entryDetail', {
          transactionCode: '22',
          receivingDFIIdentification: '23138010',
          checkDigit: '4',
          dfiAccountNumber: '000123456789',
          amount: '0000000000',
          identificationNumber: 'EMP1',
          individualName: 'JANE DOE',
          addendaRecordIndicator: '1',
          traceNumber: '123456780000001'
        }),
        addenda: [rec('addenda98', {
          addendaTypeCode: '98',
          changeCode: 'C01',
          originalEntryTraceNumber: '123456780000005',
          originalReceivingDFIIdentification: '23138010',
          correctedData: '000999888777',
          traceNumber: '123456780000001'
        })]
      }],
      control: rec('batchControl')
    }],
    fileControl: rec('fileControl'),
    padding: 0,
    parseIssues: []
  };
  const text = ACH.buildFile(doc, { lineEnding: '\r\n', finalNewline: true });
  const parsed = ACH.parseFile(text).doc;
  const addenda = parsed.batches[0].entries[0].addenda[0];
  assert.equal(addenda.kind, 'addenda98');
  assert.equal(addenda.fields.changeCode, 'C01');
  assert.equal(addenda.fields.correctedData.trim(), '000999888777');
  assert.equal(addenda.fields.originalEntryTraceNumber, '123456780000005');
  const issues = ACH.validate(parsed, { autoFix: true });
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
});

test('addenda 99 (return) round-trips', () => {
  const doc = {
    fileHeader: rec('fileHeader', {
      priorityCode: '01',
      immediateDestination: ' 231380104',
      immediateOrigin: ' 123456789',
      fileCreationDate: '261105',
      fileIDModifier: 'A'
    }),
    batches: [{
      header: rec('batchHeader', {
        serviceClassCode: '220',
        companyName: 'ACME PAYROLL INC',
        companyIdentification: '1234567890',
        standardEntryClassCode: 'PPD',
        companyEntryDescription: 'RETURN',
        effectiveEntryDate: '261106',
        originatorStatusCode: '1',
        originatingDFIIdentification: '12345678',
        batchNumber: '0000001'
      }),
      entries: [{
        detail: rec('entryDetail', {
          transactionCode: '21',
          receivingDFIIdentification: '23138010',
          checkDigit: '4',
          dfiAccountNumber: '000123456789',
          amount: '0000250000',
          identificationNumber: 'EMP1',
          individualName: 'JANE DOE',
          addendaRecordIndicator: '1',
          traceNumber: '123456780000001'
        }),
        addenda: [rec('addenda99', {
          addendaTypeCode: '99',
          returnReasonCode: 'R01',
          originalEntryTraceNumber: '123456780000005',
          dateOfDeath: '',
          originalReceivingDFIIdentification: '23138010',
          addendaInformation: '',
          traceNumber: '123456780000001'
        })]
      }],
      control: rec('batchControl')
    }],
    fileControl: rec('fileControl'),
    padding: 0,
    parseIssues: []
  };
  const text = ACH.buildFile(doc, { lineEnding: '\n', finalNewline: false });
  const parsed = ACH.parseFile(text).doc;
  const addenda = parsed.batches[0].entries[0].addenda[0];
  assert.equal(addenda.kind, 'addenda99');
  assert.equal(addenda.fields.returnReasonCode, 'R01');
  assert.equal(addenda.fields.originalEntryTraceNumber, '123456780000005');
});

test('CTX entry layout stores addenda count and company name in the right positions', () => {
  const doc = {
    fileHeader: rec('fileHeader', {
      priorityCode: '01',
      immediateDestination: ' 231380104',
      immediateOrigin: ' 123456789',
      fileCreationDate: '261105',
      fileIDModifier: 'A'
    }),
    batches: [{
      header: rec('batchHeader', {
        serviceClassCode: '220',
        companyName: 'ACME CORP',
        companyIdentification: '1234567890',
        standardEntryClassCode: 'CTX',
        companyEntryDescription: 'VENDORPAY',
        effectiveEntryDate: '261106',
        originatorStatusCode: '1',
        originatingDFIIdentification: '12345678',
        batchNumber: '0000001'
      }),
      entries: [{
        detail: rec('entryDetailCTX', {
          transactionCode: '22',
          receivingDFIIdentification: '02100002',
          checkDigit: '1',
          dfiAccountNumber: '999888777',
          amount: '0001000000',
          identificationNumber: 'INV-42',
          receivingCompanyName: 'SUPPLIER LLC',
          addendaRecordIndicator: '1',
          traceNumber: '123456780000001'
        }),
        addenda: [
          rec('addenda', {
            addendaTypeCode: '05',
            paymentRelatedInformation: 'ISA*00*          *00*',
            addendaSequenceNumber: '0001',
            entryDetailSequenceNumber: '0000001'
          }),
          rec('addenda', {
            addendaTypeCode: '05',
            paymentRelatedInformation: 'REF*INV-42',
            addendaSequenceNumber: '0002',
            entryDetailSequenceNumber: '0000001'
          })
        ]
      }],
      control: rec('batchControl')
    }],
    fileControl: rec('fileControl'),
    padding: 0,
    parseIssues: []
  };
  ACH.applyComputed(doc);
  assert.equal(doc.batches[0].entries[0].detail.fields.numberOfAddendaRecords, '0002');
  const text = ACH.buildFile(doc, { lineEnding: '\n', finalNewline: false });
  const entryLine = text.split('\n')[2];
  assert.equal(entryLine.slice(54, 58), '0002');
  assert.equal(entryLine.slice(58, 74).trim(), 'SUPPLIER LLC');
  assert.equal(entryLine.slice(78, 79), '1');
  const parsed = ACH.parseFile(text).doc;
  assert.equal(parsed.batches[0].entries[0].detail.kind, 'entryDetailCTX');
  assert.equal(parsed.batches[0].entries[0].detail.fields.numberOfAddendaRecords, '0002');
});

test('build pads the file to a ten-record block boundary', () => {
  const { doc } = ACH.parseFile(sampleText);
  const computed = ACH.computeTotals(doc);
  const text = ACH.buildFile(doc, { lineEnding: '\n', finalNewline: false, applyComputed: true });
  const lines = text.split('\n');
  assert.equal(lines.length % 10, 0);
  assert.equal(lines.length, computed.file.blockCount * 10);
  assert.equal(Number(ACH.parseFile(text).doc.fileControl.fields.blockCount), computed.file.blockCount);
});

test('amount helpers format cents and accept dollar input', () => {
  assert.equal(ACH.formatCents('0000250000'), '$2,500.00');
  assert.equal(ACH.formatCents(''), '$0.00');
  assert.equal(ACH.parseDollarsToCents('2,500.00'), '250000');
  assert.equal(ACH.parseDollarsToCents('12.5'), '1250');
  assert.equal(ACH.parseDollarsToCents('abc'), null);
});

test('field overflow is reported', () => {
  const { doc } = ACH.parseFile(sampleText);
  doc.fileHeader.fields.referenceCode = 'TOO-LONG-REFERENCE';
  const issues = ACH.validate(doc, { autoFix: true });
  assert.ok(issues.some((i) => i.path === 'fh.referenceCode' && i.severity === 'error'));
});

console.log('\n' + passed + ' tests passed.');
