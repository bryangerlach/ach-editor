/*
 * ACH Studio core
 * NACHA (ACH) file parsing, serialization, control totals and validation.
 *
 * Works both in the browser (window.ACHCore) and in Node (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ACHCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var RECORD_LENGTH = 94;
  var HASH_MOD = 10000000000;

  /* ------------------------------------------------------------------ *
   * Field definitions
   * ------------------------------------------------------------------ */

  function f(key, label, start, length, opts) {
    var def = {
      key: key,
      label: label,
      start: start,
      length: length,
      align: 'left',
      pad: ' ',
      numeric: false,
      required: false,
      readonly: false,
      derived: false,
      wide: length >= 30
    };
    if (opts) {
      Object.keys(opts).forEach(function (k) { def[k] = opts[k]; });
    }
    if (def.wide === false && length >= 30) def.wide = false;
    return def;
  }

  function num(key, label, start, length, opts) {
    var base = {
      numeric: true,
      align: 'right',
      pad: '0',
      required: true
    };
    if (opts) Object.keys(opts).forEach(function (k) { base[k] = opts[k]; });
    return f(key, label, start, length, base);
  }

  var TRANSACTION_CODES = {
    '21': { label: 'Return / NOC \u2014 checking credit', type: 'credit', account: 'checking' },
    '22': { label: 'Credit to checking', type: 'credit', account: 'checking' },
    '23': { label: 'Prenotification of credit to checking', type: 'credit', account: 'checking', prenote: true },
    '24': { label: 'Zero-dollar remittance credit to checking', type: 'credit', account: 'checking', zero: true },
    '26': { label: 'Return / NOC \u2014 checking debit', type: 'debit', account: 'checking' },
    '27': { label: 'Debit from checking', type: 'debit', account: 'checking' },
    '28': { label: 'Prenotification of debit from checking', type: 'debit', account: 'checking', prenote: true },
    '29': { label: 'Zero-dollar remittance debit from checking', type: 'debit', account: 'checking', zero: true },
    '31': { label: 'Return / NOC \u2014 savings credit', type: 'credit', account: 'savings' },
    '32': { label: 'Credit to savings', type: 'credit', account: 'savings' },
    '33': { label: 'Prenotification of credit to savings', type: 'credit', account: 'savings', prenote: true },
    '34': { label: 'Zero-dollar remittance credit to savings', type: 'credit', account: 'savings', zero: true },
    '36': { label: 'Return / NOC \u2014 savings debit', type: 'debit', account: 'savings' },
    '37': { label: 'Debit from savings', type: 'debit', account: 'savings' },
    '38': { label: 'Prenotification of debit from savings', type: 'debit', account: 'savings', prenote: true },
    '39': { label: 'Zero-dollar remittance debit from savings', type: 'debit', account: 'savings', zero: true },
    '41': { label: 'Return / NOC \u2014 general ledger credit', type: 'credit', account: 'general ledger' },
    '42': { label: 'Credit to general ledger', type: 'credit', account: 'general ledger' },
    '43': { label: 'Prenotification of credit to general ledger', type: 'credit', account: 'general ledger', prenote: true },
    '44': { label: 'Zero-dollar remittance credit to general ledger', type: 'credit', account: 'general ledger', zero: true },
    '46': { label: 'Return / NOC \u2014 general ledger debit', type: 'debit', account: 'general ledger' },
    '47': { label: 'Debit from general ledger', type: 'debit', account: 'general ledger' },
    '48': { label: 'Prenotification of debit from general ledger', type: 'debit', account: 'general ledger', prenote: true },
    '49': { label: 'Zero-dollar remittance debit from general ledger', type: 'debit', account: 'general ledger', zero: true },
    '51': { label: 'Return / NOC \u2014 loan credit', type: 'credit', account: 'loan' },
    '52': { label: 'Credit to loan account', type: 'credit', account: 'loan' },
    '53': { label: 'Prenotification of credit to loan account', type: 'credit', account: 'loan', prenote: true },
    '54': { label: 'Zero-dollar remittance credit to loan account', type: 'credit', account: 'loan', zero: true },
    '55': { label: 'Loan reversal (debit)', type: 'debit', account: 'loan' },
    '56': { label: 'Return / NOC \u2014 loan debit', type: 'debit', account: 'loan' }
  };

  var SERVICE_CLASSES = {
    '200': 'Mixed debits and credits',
    '220': 'Credits only',
    '225': 'Debits only',
    '280': 'Automated accounting advice'
  };

  var SEC_CODES = {
    ACK: 'Acknowledgment (CCD)',
    ADV: 'Automated accounting advice',
    ARC: 'Accounts receivable check conversion',
    ATX: 'Acknowledgment (CTX)',
    BOC: 'Back-office check conversion',
    CCD: 'Corporate credit or debit',
    CIE: 'Customer-initiated entry',
    COR: 'Notification of change',
    CTX: 'Corporate trade exchange',
    DNE: 'Death notification entry',
    ENR: 'Automated enrollment',
    IAT: 'International ACH transaction',
    MTE: 'Machine transfer entry',
    POP: 'Point-of-purchase entry',
    POS: 'Point-of-sale entry',
    PPD: 'Prearranged payment or deposit',
    RCK: 'Re-presented check entry',
    SHR: 'Shared network transaction',
    TEL: 'Telephone-initiated entry',
    TRC: 'Truncated check entry',
    TRX: 'Check truncation entry',
    WEB: 'Internet-initiated entry',
    XCK: 'Destroyed check entry'
  };

  var ADDENDA_TYPES = {
    '02': 'POS / MTE / SHR addenda',
    '05': 'Payment-related information',
    '98': 'Notification of change (NOC)',
    '99': 'Return entry'
  };

  var RETURN_CODES = {
    R01: 'Insufficient funds', R02: 'Account closed', R03: 'No account / unable to locate account',
    R04: 'Invalid account number', R05: 'Improper debit to consumer account', R06: 'Returned per ODFI request',
    R07: 'Authorization revoked by customer', R08: 'Payment stopped', R09: 'Uncollected funds',
    R10: 'Customer advises not authorized', R11: 'Not in accordance with authorization', R12: 'Branch sold to another DFI',
    R13: 'RDFI not qualified to participate', R14: 'Representative payee deceased', R15: 'Beneficiary or account holder deceased',
    R16: 'Account frozen', R17: 'File record edit criteria', R18: 'Improper effective entry date',
    R19: 'Amount field error', R20: 'Non-payment account', R21: 'Invalid company ID', R22: 'Invalid individual ID',
    R23: 'Credit refused by receiver', R24: 'Duplicate entry', R25: 'Addenda error', R26: 'Mandatory field error',
    R27: 'Trace number error', R28: 'Routing check digit error', R29: 'Corporate customer advises not authorized',
    R30: 'RDFI not in check truncation program', R31: 'Permissible return (CCD/CTX)', R32: 'RDFI non-settlement',
    R33: 'Return of XCK entry', R34: 'Limited participation RDFI', R35: 'Improper debit entry',
    R36: 'Improper credit entry', R37: 'Source document presented', R38: 'Stop payment on source document',
    R39: 'Improper source document', R40: 'Return of ENR by agency', R41: 'Invalid transaction code (ENR)',
    R42: 'Routing number / check digit error (ENR)', R43: 'Invalid DFI account (ENR)', R44: 'Invalid individual ID (ENR)',
    R45: 'Invalid name (ENR)', R46: 'Invalid representative payee indicator (ENR)', R47: 'Duplicate enrollment (ENR)',
    R50: 'State law affecting RCK', R51: 'Ineligible RCK item', R52: 'Stop payment on RCK item',
    R53: 'Item and RCK both presented', R61: 'Misrouted return', R62: 'Erroneous or reversing debit',
    R67: 'Duplicate return', R68: 'Untimely return', R69: 'Field error(s)', R70: 'Permissible return not accepted',
    R71: 'Misrouted dishonored return', R72: 'Untimely dishonored return', R73: 'Timely original return',
    R74: 'Corrected return', R75: 'Return not a duplicate', R76: 'No errors found',
    R77: 'Non-acceptance of R62 dishonored return', R80: 'IAT coding error', R81: 'Non-participant in IAT',
    R82: 'Invalid foreign receiving DFI', R83: 'Foreign DFI unable to settle', R84: 'Entry not processed by gateway',
    R85: 'Incorrectly coded outbound IAT', R90: 'Return due to sanctions compliance'
  };

  var CHANGE_CODES = {
    C01: 'Incorrect account number', C02: 'Incorrect routing number', C03: 'Incorrect routing and account number',
    C04: 'Incorrect individual name', C05: 'Incorrect transaction code', C06: 'Incorrect account number and transaction code',
    C07: 'Incorrect routing, account number and transaction code', C08: 'Incorrect receiving routing (IAT)',
    C09: 'Incorrect individual identification', C13: 'Addenda format error', C14: 'Incorrect SEC code for outbound IAT',
    C61: 'Misrouted NOC', C62: 'Incorrect trace number', C63: 'Incorrect company ID',
    C64: 'Incorrect individual ID', C65: 'Incorrectly formatted corrected data', C66: 'Incorrect discretionary data',
    C67: 'Routing not from original entry', C68: 'Account not from original entry', C69: 'Incorrect transaction code'
  };

  var FILE_HEADER = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '1', readonly: true, hint: 'Always 1 for a file header.' }),
    f('priorityCode', 'Priority Code', 2, 2, { numeric: true, required: true, align: 'right', pad: '0', default: '01', hint: 'Currently always 01.' }),
    f('immediateDestination', 'Immediate Destination', 4, 10, { required: true, numeric: false, hint: 'Nine-digit routing number of the receiving ACH operator, preceded by a space.' }),
    f('immediateOrigin', 'Immediate Origin', 14, 10, { required: true, numeric: false, hint: 'Nine-digit routing number (or assigned company ID) of the sender, preceded by a space.' }),
    f('fileCreationDate', 'File Creation Date', 24, 6, { date: true, required: true, numeric: true, hint: 'YYMMDD date the file was created.' }),
    f('fileCreationTime', 'File Creation Time', 30, 4, { time: true, numeric: true, hint: 'HHMM in 24-hour time. Optional.' }),
    f('fileIDModifier', 'File ID Modifier', 34, 1, { required: true, hint: 'A\u2013Z or 0\u20139. Distinguishes multiple files sent the same day.' }),
    f('recordSize', 'Record Size', 35, 3, { fixed: '094', readonly: true, hint: 'Always 094.' }),
    f('blockingFactor', 'Blocking Factor', 38, 2, { fixed: '10', readonly: true, hint: 'Always 10 records per block.' }),
    f('formatCode', 'Format Code', 40, 1, { fixed: '1', readonly: true, hint: 'Always 1.' }),
    f('immediateDestinationName', 'Immediate Destination Name', 41, 23, { hint: 'Name of the receiving ACH operator or institution.' }),
    f('immediateOriginName', 'Immediate Origin Name', 64, 23, { hint: 'Name of the sending institution or originator.' }),
    f('referenceCode', 'Reference Code', 87, 8, { hint: 'Free-form reference for the file.' })
  ];

  var BATCH_HEADER = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '5', readonly: true, hint: 'Always 5 for a batch header.' }),
    f('serviceClassCode', 'Service Class Code', 2, 3, {
      numeric: true, required: true, align: 'right', pad: '0', default: '200',
      hint: '200 = mixed, 220 = credits only, 225 = debits only.'
    }),
    f('companyName', 'Company Name', 5, 16, { required: true, hint: 'Originator name shown to the receiver.' }),
    f('companyDiscretionaryData', 'Company Discretionary Data', 21, 20, { hint: 'Optional data defined by the originator or ODFI.' }),
    f('companyIdentification', 'Company Identification', 41, 10, { required: true, hint: 'Company ID assigned by the ODFI (often 10 digits).' }),
    f('standardEntryClassCode', 'Standard Entry Class Code', 51, 3, { required: true, default: 'PPD', hint: 'SEC code describing the entry type, e.g. PPD, CCD, CTX, WEB.' }),
    f('companyEntryDescription', 'Company Entry Description', 54, 10, { required: true, hint: 'Short description shown on the receiver statement, e.g. PAYROLL.' }),
    f('companyDescriptiveDate', 'Company Descriptive Date', 64, 6, { hint: 'Optional descriptive date (often YYMMDD).' }),
    f('effectiveEntryDate', 'Effective Entry Date', 70, 6, { date: true, numeric: true, hint: 'YYMMDD date the originator intends entries to settle.' }),
    f('settlementDate', 'Settlement Date (Julian)', 76, 3, { numeric: true, required: false, align: 'right', pad: '0', hint: 'Inserted by the ACH operator. Usually blank in an originated file.' }),
    f('originatorStatusCode', 'Originator Status Code', 79, 1, { required: true, default: '1', hint: '1 = depository financial institution; 2 = federal government.' }),
    f('originatingDFIIdentification', 'Originating DFI Identification', 80, 8, { numeric: true, required: true, hint: 'First eight digits of the ODFI routing number. Prefixes trace numbers.' }),
    f('batchNumber', 'Batch Number', 88, 7, { numeric: true, required: true, hint: 'Sequential batch number, starting at 1.' })
  ];

  var ENTRY_DETAIL = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '6', readonly: true, hint: 'Always 6 for an entry detail.' }),
    f('transactionCode', 'Transaction Code', 2, 2, {
      numeric: true, required: true, align: 'right', pad: '0', default: '22',
      hint: 'Two-digit code describing credit/debit and account type.'
    }),
    f('receivingDFIIdentification', 'Receiving DFI Identification', 4, 8, { numeric: true, required: true, hint: 'First eight digits of the receiver bank routing number.' }),
    f('checkDigit', 'Check Digit', 12, 1, { numeric: true, required: true, align: 'right', pad: '0', hint: 'Ninth digit of the receiver routing number.' }),
    f('dfiAccountNumber', 'DFI Account Number', 13, 17, { required: true, hint: 'Receiver account number at the RDFI.' }),
    f('amount', 'Amount', 30, 10, { numeric: true, required: true, align: 'right', pad: '0', amount: true, hint: 'Amount in cents, no decimal point. $12.50 = 0000001250.' }),
    f('identificationNumber', 'Identification Number', 40, 15, { hint: 'Originator-assigned ID for the receiver (employee ID, invoice, etc.).' }),
    f('individualName', 'Individual / Company Name', 55, 22, { hint: 'Receiver name shown on the account statement.' }),
    f('discretionaryData', 'Discretionary Data', 77, 2, { hint: 'ODFI-defined codes. Used as the payment type code for WEB/TEL.' }),
    f('addendaRecordIndicator', 'Addenda Record Indicator', 79, 1, {
      numeric: true, required: true, align: 'right', pad: '0', default: '0', derived: true,
      hint: '1 when one or more addenda records follow, otherwise 0.'
    }),
    f('traceNumber', 'Trace Number', 80, 15, { numeric: true, required: true, hint: 'Eight-digit ODFI routing prefix plus a seven-digit sequence.' })
  ];

  var ENTRY_DETAIL_CTX = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '6', readonly: true, hint: 'Always 6 for an entry detail.' }),
    f('transactionCode', 'Transaction Code', 2, 2, {
      numeric: true, required: true, align: 'right', pad: '0', default: '22',
      hint: 'Two-digit code describing credit/debit and account type.'
    }),
    f('receivingDFIIdentification', 'Receiving DFI Identification', 4, 8, { numeric: true, required: true, hint: 'First eight digits of the receiver bank routing number.' }),
    f('checkDigit', 'Check Digit', 12, 1, { numeric: true, required: true, align: 'right', pad: '0', hint: 'Ninth digit of the receiver routing number.' }),
    f('dfiAccountNumber', 'DFI Account Number', 13, 17, { required: true, hint: 'Receiver account number at the RDFI.' }),
    f('amount', 'Amount', 30, 10, { numeric: true, required: true, align: 'right', pad: '0', amount: true, hint: 'Amount in cents, no decimal point.' }),
    f('identificationNumber', 'Identification Number', 40, 15, { hint: 'Originator-assigned ID for the receiver.' }),
    f('numberOfAddendaRecords', 'Number of Addenda Records', 55, 4, {
      numeric: true, align: 'right', pad: '0', derived: true,
      hint: 'CTX-specific count of addenda records for this entry.'
    }),
    f('receivingCompanyName', 'Receiving Company Name', 59, 16, { hint: 'Receiver company name (CTX layout).' }),
    f('reserved', 'Reserved', 75, 2, { readonly: true, hint: 'Reserved; leave blank.' }),
    f('discretionaryData', 'Discretionary Data', 77, 2, { hint: 'ODFI-defined codes.' }),
    f('addendaRecordIndicator', 'Addenda Record Indicator', 79, 1, {
      numeric: true, required: true, align: 'right', pad: '0', default: '0', derived: true,
      hint: '1 when one or more addenda records follow, otherwise 0.'
    }),
    f('traceNumber', 'Trace Number', 80, 15, { numeric: true, required: true, hint: 'Eight-digit ODFI routing prefix plus a seven-digit sequence.' })
  ];

  var ENTRY_DETAIL_CIE = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '6', readonly: true, hint: 'Always 6 for an entry detail.' }),
    f('transactionCode', 'Transaction Code', 2, 2, {
      numeric: true, required: true, align: 'right', pad: '0', default: '22',
      hint: 'Two-digit code describing credit/debit and account type.'
    }),
    f('receivingDFIIdentification', 'Receiving DFI Identification', 4, 8, { numeric: true, required: true, hint: 'First eight digits of the receiver bank routing number.' }),
    f('checkDigit', 'Check Digit', 12, 1, { numeric: true, required: true, align: 'right', pad: '0', hint: 'Ninth digit of the receiver routing number.' }),
    f('dfiAccountNumber', 'DFI Account Number', 13, 17, { required: true, hint: 'Receiver account number at the RDFI.' }),
    f('amount', 'Amount', 30, 10, { numeric: true, required: true, align: 'right', pad: '0', amount: true, hint: 'Amount in cents, no decimal point.' }),
    f('individualName', 'Individual Name', 40, 15, { hint: 'CIE/MTE layout: receiver name is in field 7.' }),
    f('identificationNumber', 'Identification Number', 55, 22, { hint: 'CIE/MTE layout: identification number is in field 8.' }),
    f('discretionaryData', 'Discretionary Data', 77, 2, { hint: 'ODFI-defined codes.' }),
    f('addendaRecordIndicator', 'Addenda Record Indicator', 79, 1, {
      numeric: true, required: true, align: 'right', pad: '0', default: '0', derived: true,
      hint: '1 when one or more addenda records follow, otherwise 0.'
    }),
    f('traceNumber', 'Trace Number', 80, 15, { numeric: true, required: true, hint: 'Eight-digit ODFI routing prefix plus a seven-digit sequence.' })
  ];

  var ADDENDA = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '7', readonly: true, hint: 'Always 7 for an addenda record.' }),
    f('addendaTypeCode', 'Addenda Type Code', 2, 2, { required: true, default: '05', hint: '05 = payment information.' }),
    f('paymentRelatedInformation', 'Payment Related Information', 4, 80, { wide: true, hint: 'Free-form remittance or payment information.' }),
    f('addendaSequenceNumber', 'Addenda Sequence Number', 84, 4, {
      numeric: true, required: true, align: 'right', pad: '0', derived: true,
      hint: 'Sequence of this addenda record under the entry, starting at 1.'
    }),
    f('entryDetailSequenceNumber', 'Entry Detail Sequence Number', 88, 7, {
      numeric: true, required: true, align: 'right', pad: '0', derived: true,
      hint: 'Last seven digits of the related entry\u2019s trace number.'
    })
  ];

  var ADDENDA_98 = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '7', readonly: true, hint: 'Always 7 for an addenda record.' }),
    f('addendaTypeCode', 'Addenda Type Code', 2, 2, { required: true, default: '98', hint: '98 = notification of change.' }),
    f('changeCode', 'Change Code', 4, 3, { required: true, hint: 'C01\u2013C14 describe what needs correcting; C61\u2013C69 refuse a NOC.' }),
    f('originalEntryTraceNumber', 'Original Entry Trace Number', 7, 15, { numeric: true, required: true, hint: 'Trace number of the original entry being corrected.' }),
    f('reservedOne', 'Reserved', 22, 6, { readonly: true, hint: 'Reserved; leave blank.' }),
    f('originalReceivingDFIIdentification', 'Original Receiving DFI Identification', 28, 8, { numeric: true, hint: 'First eight digits of the original RDFI routing number.' }),
    f('correctedData', 'Corrected Data', 36, 29, { wide: true, hint: 'Corrected value. Content depends on the change code.' }),
    f('reservedTwo', 'Reserved', 65, 15, { readonly: true, hint: 'Reserved; leave blank.' }),
    f('traceNumber', 'Trace Number', 80, 15, { numeric: true, required: true, derived: true, hint: 'Matches the related entry detail trace number.' })
  ];

  var ADDENDA_99 = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '7', readonly: true, hint: 'Always 7 for an addenda record.' }),
    f('addendaTypeCode', 'Addenda Type Code', 2, 2, { required: true, default: '99', hint: '99 = return entry.' }),
    f('returnReasonCode', 'Return Reason Code', 4, 3, { required: true, hint: 'R01\u2013R90 describing why the entry is being returned.' }),
    f('originalEntryTraceNumber', 'Original Entry Trace Number', 7, 15, { numeric: true, required: true, hint: 'Trace number of the original entry being returned.' }),
    f('dateOfDeath', 'Date of Death', 22, 6, { numeric: true, required: false, hint: 'YYMMDD, used with R14/R15. Otherwise blank.' }),
    f('originalReceivingDFIIdentification', 'Original Receiving DFI Identification', 28, 8, { numeric: true, hint: 'First eight digits of the original RDFI routing number.' }),
    f('addendaInformation', 'Addenda Information', 36, 44, { wide: true, hint: 'Supporting information for certain return codes.' }),
    f('traceNumber', 'Trace Number', 80, 15, { numeric: true, required: true, derived: true, hint: 'Matches the related entry detail trace number.' })
  ];

  var ADDENDA_RAW = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '7', readonly: true, hint: 'Always 7 for an addenda record.' }),
    f('addendaTypeCode', 'Addenda Type Code', 2, 2, { required: true, hint: 'Addenda type. Layouts other than 05/98/99 are edited as raw text.' }),
    f('rawData', 'Raw Addenda Data', 4, 91, { wide: true, hint: 'Unrecognized addenda layout. Edit the remaining 91 characters directly.' })
  ];

  var BATCH_CONTROL = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '8', readonly: true, hint: 'Always 8 for a batch control.' }),
    f('serviceClassCode', 'Service Class Code', 2, 3, { numeric: true, required: true, align: 'right', pad: '0', derived: true, hint: 'Copied from the batch header.' }),
    f('entryAddendaCount', 'Entry / Addenda Count', 5, 6, { numeric: true, required: true, align: 'right', pad: '0', derived: true, hint: 'Entry detail records plus addenda records in this batch.' }),
    f('entryHash', 'Entry Hash', 11, 10, { numeric: true, required: true, align: 'right', pad: '0', derived: true, hint: 'Sum of the eight-digit receiving DFI IDs in this batch, rightmost 10 digits.' }),
    f('totalDebitEntryDollarAmount', 'Total Debit Amount', 21, 12, { numeric: true, required: true, align: 'right', pad: '0', amount: true, derived: true, hint: 'Total debit amount in cents.' }),
    f('totalCreditEntryDollarAmount', 'Total Credit Amount', 33, 12, { numeric: true, required: true, align: 'right', pad: '0', amount: true, derived: true, hint: 'Total credit amount in cents.' }),
    f('companyIdentification', 'Company Identification', 45, 10, { required: true, derived: true, hint: 'Copied from the batch header.' }),
    f('messageAuthenticationCode', 'Message Authentication Code', 55, 19, { hint: 'Optional DES-derived authentication code.' }),
    f('reserved', 'Reserved', 74, 6, { readonly: true, hint: 'Reserved; leave blank.' }),
    f('originatingDFIIdentification', 'Originating DFI Identification', 80, 8, { numeric: true, required: true, derived: true, hint: 'Copied from the batch header.' }),
    f('batchNumber', 'Batch Number', 88, 7, { numeric: true, required: true, derived: true, hint: 'Copied from the batch header.' })
  ];

  var FILE_CONTROL = [
    f('recordType', 'Record Type Code', 1, 1, { fixed: '9', readonly: true, hint: 'Always 9 for a file control.' }),
    f('batchCount', 'Batch Count', 2, 6, { numeric: true, required: true, align: 'right', pad: '0', derived: true, hint: 'Number of batches in the file.' }),
    f('blockCount', 'Block Count', 8, 6, { numeric: true, required: true, align: 'right', pad: '0', derived: true, hint: 'Number of 10-record blocks, including padding.' }),
    f('entryAddendaCount', 'Entry / Addenda Count', 14, 8, { numeric: true, required: true, align: 'right', pad: '0', derived: true, hint: 'All entry detail and addenda records in the file.' }),
    f('entryHash', 'Entry Hash', 22, 10, { numeric: true, required: true, align: 'right', pad: '0', derived: true, hint: 'Sum of batch entry hashes, rightmost 10 digits.' }),
    f('totalDebitEntryDollarAmount', 'Total Debit Amount', 32, 12, { numeric: true, required: true, align: 'right', pad: '0', amount: true, derived: true, hint: 'Total debit amount in cents.' }),
    f('totalCreditEntryDollarAmount', 'Total Credit Amount', 44, 12, { numeric: true, required: true, align: 'right', pad: '0', amount: true, derived: true, hint: 'Total credit amount in cents.' }),
    f('reserved', 'Reserved', 56, 39, { readonly: true, hint: 'Reserved; leave blank.' })
  ];

  var FIELD_DEFS = {
    fileHeader: FILE_HEADER,
    batchHeader: BATCH_HEADER,
    entryDetail: ENTRY_DETAIL,
    entryDetailCTX: ENTRY_DETAIL_CTX,
    entryDetailCIE: ENTRY_DETAIL_CIE,
    addenda: ADDENDA,
    addenda98: ADDENDA_98,
    addenda99: ADDENDA_99,
    addendaRaw: ADDENDA_RAW,
    batchControl: BATCH_CONTROL,
    fileControl: FILE_CONTROL
  };

  var RECORD_LABELS = {
    fileHeader: 'File Header',
    batchHeader: 'Batch Header',
    entryDetail: 'Entry Detail',
    entryDetailCTX: 'Entry Detail (CTX)',
    entryDetailCIE: 'Entry Detail (CIE/MTE)',
    addenda: 'Addenda',
    addenda98: 'Addenda \u2014 Notification of Change',
    addenda99: 'Addenda \u2014 Return',
    addendaRaw: 'Addenda \u2014 Raw',
    batchControl: 'Batch Control',
    fileControl: 'File Control'
  };

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  function deepClone(value) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function padNumber(value, length) {
    return String(value == null ? '' : value).padStart(length, '0');
  }

  function padText(value, length) {
    var s = String(value == null ? '' : value);
    return s.length >= length ? s.slice(0, length) : s.padEnd(length, ' ');
  }

  function cleanValue(value) {
    return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ');
  }

  function formatField(def, value) {
    var v = cleanValue(value);
    if (def.fixed != null) v = def.fixed;
    if (def.numeric) v = v.trim();
    if (v.length > def.length) v = v.slice(0, def.length);
    var padChar = def.pad || ' ';
    if (v === '') padChar = ' ';
    if (v.length < def.length) {
      v = def.align === 'right' ? v.padStart(def.length, padChar) : v.padEnd(def.length, padChar);
    }
    return v;
  }

  function stripZeros(value) {
    var s = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(s)) return s;
    var out = s.replace(/^0+/, '');
    return out === '' ? '0' : out;
  }

  function formatCents(value) {
    var digits = String(value == null ? '' : value).replace(/[^\d]/g, '');
    if (!digits) return '$0.00';
    var n = Number(digits);
    if (!Number.isFinite(n)) return '$0.00';
    return (n / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function parseDollarsToCents(value) {
    var s = String(value == null ? '' : value).replace(/[$,]/g, '').trim();
    if (!s) return '';
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return String(Math.round(Number(s) * 100));
  }

  function formatDate6(value) {
    var s = String(value == null ? '' : value).trim();
    if (!/^\d{6}$/.test(s)) return '';
    var yy = Number(s.slice(0, 2));
    var mm = Number(s.slice(2, 4));
    var dd = Number(s.slice(4, 6));
    var year = 2000 + yy;
    var d = new Date(Date.UTC(year, mm - 1, dd));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function formatTime4(value) {
    var s = String(value == null ? '' : value).trim();
    if (!/^\d{4}$/.test(s)) return '';
    var hh = Number(s.slice(0, 2));
    var mm = Number(s.slice(2, 4));
    if (hh > 23 || mm > 59) return '';
    return s.slice(0, 2) + ':' + s.slice(2, 4);
  }

  function isValidYYMMDD(value) {
    var s = String(value == null ? '' : value).trim();
    if (!/^\d{6}$/.test(s)) return false;
    var yy = Number(s.slice(0, 2));
    var mm = Number(s.slice(2, 4));
    var dd = Number(s.slice(4, 6));
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
    var year = 2000 + yy;
    var d = new Date(Date.UTC(year, mm - 1, dd));
    return d.getUTCFullYear() === year && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd;
  }

  function calculatedCheckDigit(rdfi8) {
    var s = String(rdfi8 == null ? '' : rdfi8).trim();
    if (!/^\d{8}$/.test(s)) return null;
    var d = s.split('').map(Number);
    var sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5]);
    return (10 - (sum % 10)) % 10;
  }

  function routingWithCheckDigit(rdfi8, checkDigit) {
    var computed = calculatedCheckDigit(rdfi8);
    if (computed == null) return null;
    var actual = Number(String(checkDigit == null ? '' : checkDigit).trim());
    return { computed: computed, actual: actual, valid: computed === actual };
  }

  function entryKindForSec(sec) {
    var s = String(sec == null ? '' : sec).trim().toUpperCase();
    if (s === 'CTX' || s === 'ATX' || s === 'ENR') return 'entryDetailCTX';
    if (s === 'CIE' || s === 'MTE') return 'entryDetailCIE';
    return 'entryDetail';
  }

  function addendaKindForType(type) {
    var t = String(type == null ? '' : type).trim();
    if (t === '05') return 'addenda';
    if (t === '98') return 'addenda98';
    if (t === '99') return 'addenda99';
    return 'addendaRaw';
  }

  function addendaDefaultType(kind) {
    if (kind === 'addenda98') return '98';
    if (kind === 'addenda99') return '99';
    if (kind === 'addenda') return '05';
    return '';
  }

  /* ------------------------------------------------------------------ *
   * Record creation / conversion
   * ------------------------------------------------------------------ */

  function blankFields(kind) {
    var defs = FIELD_DEFS[kind];
    if (!defs) throw new Error('Unknown record kind: ' + kind);
    var fields = {};
    defs.forEach(function (def) {
      if (def.fixed != null) fields[def.key] = def.fixed;
      else if (def.default != null) fields[def.key] = def.default;
      else if (def.numeric) fields[def.key] = '';
      else fields[def.key] = '';
    });
    return fields;
  }

  function createRecord(kind) {
    return { kind: kind, fields: blankFields(kind) };
  }

  function convertEntryRecord(record, newKind) {
    if (!record || record.kind === newKind) return record;
    var fields = blankFields(newKind);
    var old = record.fields || {};
    Object.keys(fields).forEach(function (key) {
      if (old[key] != null && old[key] !== '') fields[key] = old[key];
    });
    if ('receivingCompanyName' in fields && old.individualName) {
      fields.receivingCompanyName = String(old.individualName).slice(0, 16);
    }
    if ('individualName' in fields && old.receivingCompanyName) {
      fields.individualName = String(old.receivingCompanyName);
    }
    return { kind: newKind, fields: fields };
  }

  function convertAddendaRecord(record, newKind) {
    if (!record || record.kind === newKind) return record;
    var fields = blankFields(newKind);
    var old = record.fields || {};
    Object.keys(fields).forEach(function (key) {
      if (key === 'addendaTypeCode') return;
      if (old[key] != null) fields[key] = old[key];
    });
    fields.addendaTypeCode = addendaDefaultType(newKind);
    if (fields.addendaTypeCode === '' && old.addendaTypeCode) fields.addendaTypeCode = old.addendaTypeCode;
    return { kind: newKind, fields: fields };
  }

  /* ------------------------------------------------------------------ *
   * Parsing
   * ------------------------------------------------------------------ */

  function parseRecord(kind, line) {
    var fields = {};
    FIELD_DEFS[kind].forEach(function (def) {
      fields[def.key] = line.slice(def.start - 1, def.start - 1 + def.length);
    });
    return { kind: kind, fields: fields };
  }

  function parseFile(text) {
    if (typeof text !== 'string') throw new Error('File contents must be text.');
    var source = text.replace(/^\uFEFF/, '');
    if (!source.trim()) throw new Error('The file is empty.');

    var lineEnding = /\r\n/.test(source) ? '\r\n' : '\n';
    var finalNewline = /(?:\r\n|\n|\r)$/.test(source);
    var rawLines = source.split(/\r\n|\n|\r/);
    if (finalNewline && rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

    var parseIssues = [];
    var doc = {
      fileHeader: null,
      batches: [],
      fileControl: null,
      padding: 0,
      parseIssues: parseIssues
    };

    var currentBatch = null;
    var currentEntry = null;

    function warn(message, lineNumber) {
      parseIssues.push({
        severity: 'warning',
        path: 'file',
        message: message + (lineNumber ? ' (line ' + lineNumber + ')' : '')
      });
    }

    rawLines.forEach(function (raw, index) {
      var lineNumber = index + 1;
      if (raw.trim() === '') {
        warn('Blank line ignored', lineNumber);
        return;
      }
      if (raw.length > RECORD_LENGTH) {
        warn('Record is ' + raw.length + ' characters; truncated to 94', lineNumber);
      } else if (raw.length < RECORD_LENGTH) {
        warn('Record is ' + raw.length + ' characters; padded to 94', lineNumber);
      }
      var line = raw.length >= RECORD_LENGTH ? raw.slice(0, RECORD_LENGTH) : raw.padEnd(RECORD_LENGTH, ' ');
      var type = line.charAt(0);

      if (type === '1') {
        if (!doc.fileHeader) {
          doc.fileHeader = parseRecord('fileHeader', line);
        } else {
          warn('Additional file header ignored', lineNumber);
        }
        return;
      }

      if (type === '5') {
        if (currentBatch) {
          if (!currentBatch.control) {
            warn('Batch ' + doc.batches.length + ' is missing a control record; one was added', lineNumber);
            currentBatch.control = createRecord('batchControl');
          }
        }
        var header = parseRecord('batchHeader', line);
        currentBatch = { header: header, entries: [], control: null };
        currentEntry = null;
        doc.batches.push(currentBatch);
        return;
      }

      if (type === '6') {
        if (!currentBatch) {
          warn('Entry detail appears outside a batch; ignored', lineNumber);
          return;
        }
        var sec = currentBatch.header.fields.standardEntryClassCode;
        var detailKind = entryKindForSec(sec);
        var entry = { detail: parseRecord(detailKind, line), addenda: [] };
        currentBatch.entries.push(entry);
        currentEntry = entry;
        return;
      }

      if (type === '7') {
        if (!currentEntry) {
          warn('Addenda record appears without an entry; ignored', lineNumber);
          return;
        }
        var typeCode = line.slice(1, 3);
        var addendaKind = addendaKindForType(typeCode);
        if (addendaKind === 'addendaRaw' && typeCode !== '02') {
          warn('Addenda type ' + (typeCode.trim() || '(blank)') + ' has no built-in layout; shown as raw text', lineNumber);
        }
        currentEntry.addenda.push(parseRecord(addendaKind, line));
        return;
      }

      if (type === '8') {
        if (!currentBatch) {
          warn('Batch control appears without a batch; ignored', lineNumber);
          return;
        }
        if (currentBatch.control) {
          warn('Additional batch control ignored', lineNumber);
          return;
        }
        currentBatch.control = parseRecord('batchControl', line);
        currentBatch = null;
        currentEntry = null;
        return;
      }

      if (type === '9') {
        if (/^9+$/.test(line)) {
          doc.padding += 1;
        } else if (!doc.fileControl) {
          doc.fileControl = parseRecord('fileControl', line);
        } else {
          warn('Additional 9-record ignored', lineNumber);
        }
        return;
      }

      warn('Unknown record type "' + type + '" ignored', lineNumber);
    });

    if (!doc.fileHeader) {
      doc.fileHeader = createRecord('fileHeader');
      parseIssues.push({ severity: 'warning', path: 'file', message: 'No file header record found; a blank one was added.' });
    }

    if (currentBatch && !currentBatch.control) {
      currentBatch.control = createRecord('batchControl');
      parseIssues.push({ severity: 'warning', path: 'file', message: 'The final batch had no control record; one was added.' });
    }

    if (!doc.fileControl) {
      doc.fileControl = createRecord('fileControl');
      parseIssues.push({ severity: 'warning', path: 'file', message: 'No file control record found; a blank one was added.' });
    }

    doc.batches.forEach(function (batch) {
      if (!batch.control) batch.control = createRecord('batchControl');
    });

    if (doc.batches.length === 0) {
      parseIssues.push({ severity: 'warning', path: 'file', message: 'The file contains no batches.' });
    }

    return {
      doc: doc,
      issues: parseIssues,
      lineEnding: lineEnding,
      finalNewline: finalNewline,
      sourceLineCount: rawLines.length
    };
  }

  /* ------------------------------------------------------------------ *
   * Totals and derived values
   * ------------------------------------------------------------------ */

  function transactionType(code) {
    var s = String(code == null ? '' : code).trim();
    if (!/^\d{2}$/.test(s)) return null;
    var last = Number(s.charAt(1));
    if (last >= 1 && last <= 4) return 'credit';
    if (last >= 5 && last <= 9) return 'debit';
    return null;
  }

  function entryAmount(fields) {
    var raw = String(fields.amount == null ? '' : fields.amount).trim();
    if (!/^\d+$/.test(raw)) return 0;
    var n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function lastSeven(value) {
    var s = String(value == null ? '' : value).replace(/\s/g, '');
    if (!/^\d+$/.test(s)) return '0000000';
    return s.slice(-7).padStart(7, '0');
  }

  function pathFields(doc, path) {
    var parts = String(path).split('.');
    if (parts[0] === 'fh') return doc.fileHeader.fields;
    if (parts[0] === 'fc') return doc.fileControl.fields;
    if (parts[0].charAt(0) === 'b') {
      var batch = doc.batches[Number(parts[0].slice(1))];
      if (!batch) return null;
      if (parts[1] === 'h') return batch.header.fields;
      if (parts[1] === 'c') return batch.control.fields;
      if (parts[1] && parts[1].charAt(0) === 'e') {
        var entry = batch.entries[Number(parts[1].slice(1))];
        if (!entry) return null;
        if (parts[2] === 'd') return entry.detail.fields;
        if (parts[2] && parts[2].charAt(0) === 'a') {
          var addenda = entry.addenda[Number(parts[2].slice(1))];
          return addenda ? addenda.fields : null;
        }
      }
    }
    return null;
  }

  function kindForPath(doc, path) {
    var parts = String(path).split('.');
    if (parts[0] === 'fh') return 'fileHeader';
    if (parts[0] === 'fc') return 'fileControl';
    if (parts[0].charAt(0) === 'b') {
      var batch = doc.batches[Number(parts[0].slice(1))];
      if (!batch) return null;
      if (parts[1] === 'h') return 'batchHeader';
      if (parts[1] === 'c') return 'batchControl';
      if (parts[1] && parts[1].charAt(0) === 'e') {
        var entry = batch.entries[Number(parts[1].slice(1))];
        if (!entry) return null;
        if (parts[2] === 'd') return entry.detail.kind;
        if (parts[2] && parts[2].charAt(0) === 'a') {
          var addenda = entry.addenda[Number(parts[2].slice(1))];
          return addenda ? addenda.kind : null;
        }
      }
    }
    return null;
  }

  function fieldDefForPath(doc, path) {
    var kind = kindForPath(doc, path);
    if (!kind) return null;
    var key = String(path).split('.').pop();
    var defs = FIELD_DEFS[kind] || [];
    for (var i = 0; i < defs.length; i += 1) {
      if (defs[i].key === key) return defs[i];
    }
    return null;
  }

  function setValueAtPath(doc, path, value) {
    var fields = pathFields(doc, path);
    if (!fields) return;
    var key = String(path).split('.').pop();
    if (key in fields) fields[key] = value;
  }

  function computeTotals(doc) {
    var batches = [];
    var fileEntryCount = 0;
    var fileHash = 0;
    var fileDebit = 0;
    var fileCredit = 0;

    doc.batches.forEach(function (batch) {
      var count = 0;
      var hash = 0;
      var debit = 0;
      var credit = 0;

      batch.entries.forEach(function (entry) {
        var fields = entry.detail.fields;
        count += 1 + entry.addenda.length;

        var rdfi = String(fields.receivingDFIIdentification == null ? '' : fields.receivingDFIIdentification).trim();
        if (/^\d+$/.test(rdfi)) hash += Number(rdfi);

        var type = transactionType(fields.transactionCode);
        var amount = entryAmount(fields);
        if (type === 'debit') debit += amount;
        else if (type === 'credit') credit += amount;
      });

      hash = hash % HASH_MOD;
      batches.push({
        entryAddendaCount: count,
        entryHash: hash,
        debit: debit,
        credit: credit,
        records: 2 + count
      });
      fileEntryCount += count;
      fileHash = (fileHash + hash) % HASH_MOD;
      fileDebit += debit;
      fileCredit += credit;
    });

    var totalRecords = 2;
    batches.forEach(function (b) { totalRecords += b.records; });
    var blockCount = Math.ceil(totalRecords / 10);
    var padding = blockCount * 10 - totalRecords;

    var computed = {
      batches: batches,
      file: {
        batchCount: doc.batches.length,
        blockCount: blockCount,
        entryAddendaCount: fileEntryCount,
        entryHash: fileHash,
        debit: fileDebit,
        credit: fileCredit,
        totalRecords: totalRecords,
        padding: padding
      },
      paths: {}
    };

    function put(path, value) {
      var def = fieldDefForPath(doc, path);
      computed.paths[path] = def ? formatField(def, value) : String(value);
    }

    doc.batches.forEach(function (batch, bi) {
      var c = batches[bi];
      var bp = 'b' + bi;
      put(bp + '.c.serviceClassCode', batch.header.fields.serviceClassCode);
      put(bp + '.c.entryAddendaCount', c.entryAddendaCount);
      put(bp + '.c.entryHash', c.entryHash);
      put(bp + '.c.totalDebitEntryDollarAmount', c.debit);
      put(bp + '.c.totalCreditEntryDollarAmount', c.credit);
      put(bp + '.c.companyIdentification', batch.header.fields.companyIdentification);
      put(bp + '.c.originatingDFIIdentification', batch.header.fields.originatingDFIIdentification);
      put(bp + '.c.batchNumber', batch.header.fields.batchNumber);

      batch.entries.forEach(function (entry, ei) {
        var ep = bp + '.e' + ei;
        put(ep + '.d.addendaRecordIndicator', entry.addenda.length > 0 ? '1' : '0');
        if ('numberOfAddendaRecords' in entry.detail.fields) {
          put(ep + '.d.numberOfAddendaRecords', entry.addenda.length);
        }
        var trace = entry.detail.fields.traceNumber;
        entry.addenda.forEach(function (addenda, ai) {
          var ap = ep + '.a' + ai;
          if (addenda.kind === 'addenda') {
            put(ap + '.addendaSequenceNumber', ai + 1);
            put(ap + '.entryDetailSequenceNumber', lastSeven(trace));
          } else if (addenda.kind === 'addenda98' || addenda.kind === 'addenda99') {
            put(ap + '.traceNumber', trace);
          } else if ('traceNumber' in addenda.fields) {
            put(ap + '.traceNumber', trace);
          }
        });
      });
    });

    put('fc.batchCount', doc.batches.length);
    put('fc.blockCount', blockCount);
    put('fc.entryAddendaCount', fileEntryCount);
    put('fc.entryHash', fileHash);
    put('fc.totalDebitEntryDollarAmount', fileDebit);
    put('fc.totalCreditEntryDollarAmount', fileCredit);

    return computed;
  }

  function applyComputed(doc) {
    var computed = computeTotals(doc);
    Object.keys(computed.paths).forEach(function (path) {
      setValueAtPath(doc, path, computed.paths[path]);
    });
    doc.padding = computed.file.padding;
    return computed;
  }

  function compareComputed(doc) {
    var computed = computeTotals(doc);
    var mismatches = [];
    Object.keys(computed.paths).forEach(function (path) {
      var fields = pathFields(doc, path);
      if (!fields) return;
      var key = path.split('.').pop();
      var stored = fields[key];
      var expected = computed.paths[path];
      var def = fieldDefForPath(doc, path);
      var equal;
      if (def && def.numeric) {
        equal = stripZeros(stored) === stripZeros(expected);
      } else {
        equal = String(stored == null ? '' : stored).trim() === String(expected == null ? '' : expected).trim();
      }
      if (!equal) {
        mismatches.push({ path: path, stored: stored, computed: expected });
      }
    });
    return { computed: computed, mismatches: mismatches };
  }

  /* ------------------------------------------------------------------ *
   * Validation
   * ------------------------------------------------------------------ */

  function validate(doc, options) {
    var opts = options || {};
    var autoFix = opts.autoFix !== false;
    var issues = [];
    var computed = computeTotals(doc);

    function add(severity, path, message) {
      issues.push({ severity: severity, path: path, message: message });
    }

    function checkRecord(record, pathPrefix) {
      var defs = FIELD_DEFS[record.kind];
      defs.forEach(function (def) {
        var path = pathPrefix + '.' + def.key;
        var value = record.fields[def.key];
        var str = String(value == null ? '' : value);
        var trimmed = str.trim();

        if (str.length > def.length) {
          add('error', path, 'Too long by ' + (str.length - def.length) + ' character(s). Maximum is ' + def.length + '.');
        }
        if (def.required && trimmed === '') {
          add('error', path, 'Required field is blank.');
        }
        if (def.numeric && trimmed !== '' && !/^\d+$/.test(trimmed)) {
          add('error', path, 'Must contain digits only.');
        }
        if (def.date && trimmed !== '' && !isValidYYMMDD(trimmed)) {
          add('warning', path, 'Date should be a valid YYMMDD date.');
        }
        if (def.time && trimmed !== '' && !/^([01]\d|2[0-3])[0-5]\d$/.test(trimmed)) {
          add('warning', path, 'Time should be a valid HHMM value.');
        }
        if (/[^\x20-\x7E]/.test(str)) {
          add('error', path, 'Contains characters outside the NACHA character set.');
        }
        if (/[a-z]/.test(str) && !def.numeric) {
          add('warning', path, 'Lowercase letters may be rejected by some processors; NACHA normally uses uppercase.');
        }
      });
    }

    checkRecord(doc.fileHeader, 'fh');
    doc.batches.forEach(function (batch, bi) {
      var bp = 'b' + bi;
      checkRecord(batch.header, bp + '.h');
      batch.entries.forEach(function (entry, ei) {
        var ep = bp + '.e' + ei;
        checkRecord(entry.detail, ep + '.d');
        entry.addenda.forEach(function (addenda, ai) {
          checkRecord(addenda, ep + '.a' + ai);
        });
      });
      checkRecord(batch.control, bp + '.c');
    });
    checkRecord(doc.fileControl, 'fc');

    // Fixed / code checks
    var fh = doc.fileHeader.fields;
    if (fh.priorityCode.trim() !== '' && fh.priorityCode.trim() !== '01') {
      add('warning', 'fh.priorityCode', 'Priority code is normally 01.');
    }
    var dest = fh.immediateDestination.trim();
    if (dest !== '' && !/^\d{9}$/.test(dest)) {
      add('warning', 'fh.immediateDestination', 'Expected a nine-digit routing number (usually preceded by a space).');
    }
    var origin = fh.immediateOrigin.trim();
    if (origin !== '' && !/^\d{9}$/.test(origin)) {
      add('warning', 'fh.immediateOrigin', 'Expected a nine-digit routing number or company ID.');
    }
    if (fh.fileIDModifier.trim() !== '' && !/^[A-Z0-9]$/.test(fh.fileIDModifier.trim())) {
      add('error', 'fh.fileIDModifier', 'File ID modifier must be A\u2013Z or 0\u20139.');
    }

    // Batch-level checks
    var seenTraces = {};
    doc.batches.forEach(function (batch, bi) {
      var bp = 'b' + bi;
      var bh = batch.header.fields;
      var bc = batch.control.fields;
      var scc = bh.serviceClassCode.trim();
      var sec = bh.standardEntryClassCode.trim().toUpperCase();
      var debit = 0;
      var credit = 0;

      batch.entries.forEach(function (entry) {
        var type = transactionType(entry.detail.fields.transactionCode);
        var amount = entryAmount(entry.detail.fields);
        if (type === 'debit') debit += amount;
        else if (type === 'credit') credit += amount;
      });

      if (scc !== '' && !SERVICE_CLASSES[scc]) {
        add('error', bp + '.h.serviceClassCode', 'Unknown service class code. Use 200, 220 or 225.');
      }
      if (scc === '220' && debit > 0) {
        add('error', bp + '.h.serviceClassCode', 'Service class 220 allows credits only, but this batch contains debit entries.');
      }
      if (scc === '225' && credit > 0) {
        add('error', bp + '.h.serviceClassCode', 'Service class 225 allows debits only, but this batch contains credit entries.');
      }
      if (sec !== '' && !/^[A-Z0-9]{3}$/.test(sec)) {
        add('warning', bp + '.h.standardEntryClassCode', 'SEC code should be three uppercase letters or digits.');
      } else if (sec !== '' && !SEC_CODES[sec]) {
        add('warning', bp + '.h.standardEntryClassCode', 'Unrecognized SEC code "' + sec + '".');
      }

      var expectedBatchNumber = String(bi + 1).padStart(7, '0');
      if (bh.batchNumber.trim() !== '' && bh.batchNumber.trim() !== expectedBatchNumber) {
        add('warning', bp + '.h.batchNumber', 'Batch numbers are normally sequential. Expected ' + expectedBatchNumber + '.');
      }

      batch.entries.forEach(function (entry, ei) {
        var ep = bp + '.e' + ei;
        var fields = entry.detail.fields;
        var tc = fields.transactionCode.trim();
        var tcInfo = TRANSACTION_CODES[tc];
        var amount = entryAmount(fields);

        if (tc !== '' && !tcInfo) {
          add('warning', ep + '.d.transactionCode', 'Unrecognized transaction code "' + tc + '".');
        }
        if (tcInfo && tcInfo.prenote && amount !== 0) {
          add('error', ep + '.d.amount', 'Prenotification entries must have an amount of zero.');
        }
        if (tcInfo && tcInfo.zero && amount !== 0) {
          add('error', ep + '.d.amount', 'Zero-dollar remittance entries must have an amount of zero.');
        }

        var routing = routingWithCheckDigit(fields.receivingDFIIdentification, fields.checkDigit);
        if (routing && !routing.valid) {
          add('error', ep + '.d.checkDigit', 'Check digit does not match the receiving DFI identification (expected ' + routing.computed + ').');
        }

        var trace = fields.traceNumber.trim();
        if (trace !== '') {
          if (!/^\d{15}$/.test(trace)) {
            add('warning', ep + '.d.traceNumber', 'Trace number should be 15 digits (ODFI prefix + sequence).');
          }
          if (seenTraces[trace]) {
            add('warning', ep + '.d.traceNumber', 'Duplicate trace number; trace numbers should be unique within the file.');
          }
          seenTraces[trace] = true;

          var odfi = bh.originatingDFIIdentification.trim();
          if (/^\d{8}$/.test(odfi) && /^\d{15}$/.test(trace) && trace.slice(0, 8) !== odfi) {
            add('warning', ep + '.d.traceNumber', 'Trace number prefix does not match the batch originating DFI (' + odfi + ').');
          }
        }

        if (!autoFix) {
          var indicatorExpected = entry.addenda.length > 0 ? '1' : '0';
          if (String(fields.addendaRecordIndicator).trim() !== indicatorExpected) {
            add('error', ep + '.d.addendaRecordIndicator', 'Should be ' + indicatorExpected + ' based on the number of addenda records.');
          }
        }

        entry.addenda.forEach(function (addenda, ai) {
          var ap = ep + '.a' + ai;
          var af = addenda.fields;
          var type = String(af.addendaTypeCode == null ? '' : af.addendaTypeCode).trim();
          if (type !== '' && !ADDENDA_TYPES[type]) {
            add('warning', ap + '.addendaTypeCode', 'Unrecognized addenda type code "' + type + '".');
          }
          if (addenda.kind === 'addenda98') {
            var changeCode = String(af.changeCode || '').trim();
            if (!/^C\d{2}$/.test(changeCode)) {
              add('error', ap + '.changeCode', 'Change code should look like C01.');
            } else if (!CHANGE_CODES[changeCode]) {
              add('warning', ap + '.changeCode', 'Unrecognized change code "' + changeCode + '".');
            }
            if (String(af.correctedData || '').trim() === '') {
              add('warning', ap + '.correctedData', 'Corrected data is normally required for a NOC.');
            }
          }
          if (addenda.kind === 'addenda99') {
            var rc = String(af.returnReasonCode || '').trim();
            if (!/^R\d{2}$/.test(rc)) {
              add('error', ap + '.returnReasonCode', 'Return reason code should look like R01.');
            } else if (!RETURN_CODES[rc]) {
              add('warning', ap + '.returnReasonCode', 'Unrecognized return reason code "' + rc + '".');
            }
          }
        });
      });

      if (!autoFix) {
        var showControlValue = function (def, value) {
          var text = String(value == null ? '' : value).trim();
          if (def && def.amount) return formatCents(text);
          if (def && def.numeric) return stripZeros(text) || '0';
          return text || '(blank)';
        };
        var checkControl = function (path, stored, expected, label) {
          var def = fieldDefForPath(doc, path);
          var equal;
          if (def && def.numeric) equal = stripZeros(stored) === stripZeros(expected);
          else equal = String(stored == null ? '' : stored).trim() === String(expected == null ? '' : expected).trim();
          if (!equal) {
            add('warning', path, label + ' is ' + showControlValue(def, stored) + ' but the entries produce ' + showControlValue(def, expected) + '.');
          }
        };
        checkControl(bp + '.c.serviceClassCode', bc.serviceClassCode, bh.serviceClassCode, 'Service class code');
        checkControl(bp + '.c.entryAddendaCount', bc.entryAddendaCount, computed.paths[bp + '.c.entryAddendaCount'], 'Entry/addenda count');
        checkControl(bp + '.c.entryHash', bc.entryHash, computed.paths[bp + '.c.entryHash'], 'Entry hash');
        checkControl(bp + '.c.totalDebitEntryDollarAmount', bc.totalDebitEntryDollarAmount, computed.paths[bp + '.c.totalDebitEntryDollarAmount'], 'Total debit');
        checkControl(bp + '.c.totalCreditEntryDollarAmount', bc.totalCreditEntryDollarAmount, computed.paths[bp + '.c.totalCreditEntryDollarAmount'], 'Total credit');
        checkControl(bp + '.c.companyIdentification', bc.companyIdentification, bh.companyIdentification, 'Company identification');
        checkControl(bp + '.c.originatingDFIIdentification', bc.originatingDFIIdentification, bh.originatingDFIIdentification, 'Originating DFI');
        checkControl(bp + '.c.batchNumber', bc.batchNumber, bh.batchNumber, 'Batch number');
      }
    });

    if (!autoFix) {
      var showFileControlValue = function (def, value) {
        var text = String(value == null ? '' : value).trim();
        if (def && def.amount) return formatCents(text);
        if (def && def.numeric) return stripZeros(text) || '0';
        return text || '(blank)';
      };
      var checkFileControl = function (path, stored, expected, label) {
        var def = fieldDefForPath(doc, path);
        var equal;
        if (def && def.numeric) equal = stripZeros(stored) === stripZeros(expected);
        else equal = String(stored == null ? '' : stored).trim() === String(expected == null ? '' : expected).trim();
        if (!equal) {
          add('warning', path, label + ' is ' + showFileControlValue(def, stored) + ' but the file produces ' + showFileControlValue(def, expected) + '.');
        }
      };
      checkFileControl('fc.batchCount', doc.fileControl.fields.batchCount, computed.paths['fc.batchCount'], 'Batch count');
      checkFileControl('fc.blockCount', doc.fileControl.fields.blockCount, computed.paths['fc.blockCount'], 'Block count');
      checkFileControl('fc.entryAddendaCount', doc.fileControl.fields.entryAddendaCount, computed.paths['fc.entryAddendaCount'], 'Entry/addenda count');
      checkFileControl('fc.entryHash', doc.fileControl.fields.entryHash, computed.paths['fc.entryHash'], 'Entry hash');
      checkFileControl('fc.totalDebitEntryDollarAmount', doc.fileControl.fields.totalDebitEntryDollarAmount, computed.paths['fc.totalDebitEntryDollarAmount'], 'Total debit');
      checkFileControl('fc.totalCreditEntryDollarAmount', doc.fileControl.fields.totalCreditEntryDollarAmount, computed.paths['fc.totalCreditEntryDollarAmount'], 'Total credit');
      if ((doc.padding || 0) !== computed.file.padding) {
        add('warning', 'padding', 'Padding is ' + (doc.padding || 0) + ' record(s) but ' + computed.file.padding + ' are needed to complete the final block.');
      }
    }

    if (doc.batches.length === 0) {
      add('warning', 'file', 'The file contains no batches.');
    }

    return issues;
  }

  /* ------------------------------------------------------------------ *
   * Serialization
   * ------------------------------------------------------------------ */

  function serializeRecord(kind, fields) {
    var defs = FIELD_DEFS[kind];
    if (!defs) throw new Error('Unknown record kind: ' + kind);
    var line = '';
    defs.forEach(function (def) {
      line += formatField(def, fields[def.key]);
    });
    return line.padEnd(RECORD_LENGTH, ' ').slice(0, RECORD_LENGTH);
  }

  function buildFile(doc, options) {
    var opts = options || {};
    var apply = opts.applyComputed !== false;
    var working = apply ? deepClone(doc) : doc;
    var padding = working.padding || 0;

    if (apply) {
      applyComputed(working);
      padding = working.padding;
    }

    var lines = [];
    lines.push(serializeRecord('fileHeader', working.fileHeader.fields));
    working.batches.forEach(function (batch) {
      lines.push(serializeRecord('batchHeader', batch.header.fields));
      batch.entries.forEach(function (entry) {
        lines.push(serializeRecord(entry.detail.kind, entry.detail.fields));
        entry.addenda.forEach(function (addenda) {
          lines.push(serializeRecord(addenda.kind, addenda.fields));
        });
      });
      lines.push(serializeRecord('batchControl', batch.control.fields));
    });
    lines.push(serializeRecord('fileControl', working.fileControl.fields));
    for (var i = 0; i < padding; i += 1) lines.push('9'.repeat(RECORD_LENGTH));

    var eol = opts.lineEnding || '\r\n';
    var finalNewline = opts.finalNewline !== false;
    return lines.join(eol) + (finalNewline ? eol : '');
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  return {
    RECORD_LENGTH: RECORD_LENGTH,
    FIELD_DEFS: FIELD_DEFS,
    RECORD_LABELS: RECORD_LABELS,
    TRANSACTION_CODES: TRANSACTION_CODES,
    SERVICE_CLASSES: SERVICE_CLASSES,
    SEC_CODES: SEC_CODES,
    ADDENDA_TYPES: ADDENDA_TYPES,
    RETURN_CODES: RETURN_CODES,
    CHANGE_CODES: CHANGE_CODES,

    parseFile: parseFile,
    buildFile: buildFile,
    serializeRecord: serializeRecord,
    computeTotals: computeTotals,
    applyComputed: applyComputed,
    compareComputed: compareComputed,
    validate: validate,

    blankFields: blankFields,
    createRecord: createRecord,
    convertEntryRecord: convertEntryRecord,
    convertAddendaRecord: convertAddendaRecord,
    entryKindForSec: entryKindForSec,
    addendaKindForType: addendaKindForType,
    addendaDefaultType: addendaDefaultType,
    transactionType: transactionType,

    formatField: formatField,
    formatCents: formatCents,
    parseDollarsToCents: parseDollarsToCents,
    formatDate6: formatDate6,
    formatTime4: formatTime4,
    isValidYYMMDD: isValidYYMMDD,
    calculatedCheckDigit: calculatedCheckDigit,
    routingWithCheckDigit: routingWithCheckDigit,
    stripZeros: stripZeros,
    pathFields: pathFields,
    kindForPath: kindForPath,
    fieldDefForPath: fieldDefForPath,
    deepClone: deepClone
  };
});
