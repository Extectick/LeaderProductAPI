jest.mock('../src/modules/onec-personal/config',()=>({onecBase:jest.fn((key:string)=>{if(key==='missing')throw Object.assign(Error('missing'),{code:'ONEC_BASE_UNAVAILABLE'});return {key,rpcUrl:'https://onec.invalid/personal/hs/mcp/rpc'}})}));
import {stockProductBaseAllowed,entityProductMirrorMatches} from '../src/modules/entity-links/entity.stock-source';
const env={...process.env};afterEach(()=>{process.env={...env}});
test('a different publication needs an explicit app-catalog alias',()=>{
 process.env.ONEC_LP_APP_BASE_URL='https://mirror.invalid/catalog/hs/lp-app';delete process.env.HELP_APP_PRODUCT_BASE_KEYS;
 expect(stockProductBaseAllowed('personal')).toBe(false);
 process.env.HELP_APP_PRODUCT_BASE_KEYS='personal';expect(stockProductBaseAllowed('personal')).toBe(true);expect(stockProductBaseAllowed('other')).toBe(false);
 process.env.HELP_APP_PRODUCT_BASE_KEYS='personal,bad/alias';expect(stockProductBaseAllowed('personal')).toBe(false);
 expect(()=>stockProductBaseAllowed('missing')).toThrow();
});
test('an exactly matching publication retains the existing identity check',()=>{
 process.env.ONEC_LP_APP_BASE_URL='https://onec.invalid/personal/hs/lp-app/';expect(stockProductBaseAllowed('personal')).toBe(true);
 expect(entityProductMirrorMatches('https://onec.invalid/personal/hs/mcp/rpc','https://onec.invalid/other/hs/lp-app')).toBe(false);
});
