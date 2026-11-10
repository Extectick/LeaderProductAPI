// Scoped layer over the actual prod image; refuse unknown runtime contents.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node patch-runtime.cjs input.js output.js');
const original = fs.readFileSync(input, 'utf8');
if (createHash('sha256').update(original).digest('hex') !== '861ffd7525e00d9da03badb505fb8e0cec442e075915cd5fda861086ad20fc63') {
  throw new Error('Unknown production baseline; inspect and rebase the patch');
}
const start = original.indexOf('async function copyStoredClientOrder(');
const end = original.indexOf('\nasync function saveInvoicePreference(', start);
if (start < 0 || end < 0) throw new Error('Copy function boundaries missing');
let body = original.slice(start, end);
function once(from, to) {
  if (body.split(from).length !== 2) throw new Error('Unexpected copy function structure');
  body = body.replace(from, to);
}
once('                revision: true,\n                counterpartyId: true,',
  '                revision: true,\n                last1cSnapshot: true,\n                clientOrderId: true,\n                syncState: true,\n                counterpartyId: true,');
once('        if (!source)\n            return null;\n        const copiedAt = now();',
  `        if (!source)
            return null;
        // Invoice bookkeeping must use the authorized full-detail copy path.
        if (!source.items.length) {
            if ((0, clientOrders_invoiceShadow_1.isInvoiceShadowOrder)({ ...source, items: [] }))
                return null;
            throw new ClientOrdersError(400, apiResponse_1.ErrorCodes.VALIDATION_ERROR, 'Нельзя скопировать заказ без товаров');
        }
        const copiedAt = now();`);
fs.writeFileSync(output, original.slice(0, start) + body + original.slice(end));
console.log(JSON.stringify({ changedModule: 'clientOrders.service.js', changedFunction: 'copyStoredClientOrder',
  before: createHash('sha256').update(original).digest('hex'),
  after: createHash('sha256').update(fs.readFileSync(output)).digest('hex') }));
