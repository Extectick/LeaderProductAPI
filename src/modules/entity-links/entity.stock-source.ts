import {onecBase} from '../onec-personal/config';

export function entityProductMirrorMatches(rpcUrl:string,mirrorUrl=process.env.ONEC_LP_APP_BASE_URL):boolean {
  if(!mirrorUrl)return false;
  try{
    const rpc=new URL(rpcUrl),mirror=new URL(mirrorUrl);
    return !rpc.username&&!rpc.password&&!mirror.username&&!mirror.password&&!mirror.search&&!mirror.hash&&rpc.origin===mirror.origin&&
      /\/hs\/mcp\/rpc$/.test(rpc.pathname)&&/\/hs\/lp-app\/?$/.test(mirror.pathname)&&
      rpc.pathname.replace(/\/hs\/mcp\/rpc$/,'')===mirror.pathname.replace(/\/hs\/lp-app\/?$/,'');
  }catch{return false;}
}

/** Explicit aliases select the application's stock catalog; they do not claim
 * the live 1C publication and application mirror are the same source. */
export function stockProductBaseAllowed(baseKey:string):boolean{
 const base=onecBase(baseKey);
 if(entityProductMirrorMatches(base.rpcUrl))return true;
 const aliases=(process.env.HELP_APP_PRODUCT_BASE_KEYS||'').split(',').map(key=>key.trim()).filter(Boolean);
 return aliases.length<=20&&aliases.every(key=>/^[a-z0-9-]{1,48}$/.test(key))&&aliases.includes(base.key);
}
