const assert=require('node:assert/strict');
const {offlineExportPolicySchema,buildOfflinePolicy}=require('/app/dist/modules/clientOrders/offlineExportPolicy');
const {manualPriceTypeGuids,mayUseOrderPriceTypes,mayQueueStoredOrderPrices}=require('/app/dist/modules/clientOrders/clientOrders.manualPrices');
const p=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Omsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const payload={asOfDate:today,products:[],priceTypes:[{guid:p(1),dependencies:[p(2)]},{guid:p(3),dependencies:[p(4)]}],organizationGuids:[],warehouseGuids:[]};
let source=payload, inactive=null;
const db={offlineExportPolicy:{findUnique:async()=>({payload:source})},clientAgreement:{findMany:async()=>[{priceType:{guid:p(1)}}]},
 priceType:{findFirst:async()=>inactive},employeeProfile:{findUnique:async()=>({status:'ACTIVE',onecUserGuid:p(9),user:{isActive:true}})}};
(async()=>{
assert.deepEqual(await manualPriceTypeGuids(p(9),buildOfflinePolicy(payload,today),db),[p(1),p(2)]);
assert.equal(await mayUseOrderPriceTypes(p(9),[p(3)],db),false);
source={...payload,commonSalePriceTypeGuids:[p(3)]};
assert.equal(offlineExportPolicySchema.safeParse(source).success,true);
assert.deepEqual(await manualPriceTypeGuids(p(9),buildOfflinePolicy(source,today),db),[p(1),p(2),p(3)]);
assert.equal(buildOfflinePolicy(source,today).fingerprint,buildOfflinePolicy(payload,today).fingerprint);
assert.deepEqual(buildOfflinePolicy(source,'1999-01-01').commonSalePriceTypeGuids,[]);
assert.equal(await mayUseOrderPriceTypes(null,[p(3)],db),false);
assert.equal(await mayUseOrderPriceTypes(p(9),[p(4)],db),false);
assert.equal(await mayUseOrderPriceTypes(p(9),[p(1),p(3)],db),true);
assert.equal(await mayQueueStoredOrderPrices(db,7,{priceType:{guid:p(3)},items:[{isCancelled:true,priceType:{guid:p(6)}}]}),true);
inactive={id:'revoked'};
assert.equal(await mayUseOrderPriceTypes(p(9),[p(3)],db),false);
const svc=require('/app/dist/modules/clientOrders/clientOrders.service');
assert.equal(typeof svc.submitClientOrder,'function');assert.equal(typeof svc.getClientOrdersProductsByGuids,'function');
console.log(JSON.stringify({productionCandidate:true,legacy:true,offlineUnchanged:true,commonPriced:true,privateDenied:true,inactiveDenied:true,unmappedDenied:true,servicesLoad:true}));
})().catch(e=>{console.error(e.name,String(e.message).slice(-120));process.exitCode=1});
