import {AsyncLocalStorage} from 'node:async_hooks';

export const HELP_APP_API_ONEC_ERROR='HELP_API_PERSONAL_ONEC_REQUIRED';
export class HelpAppApiPersonalOnecRequiredError extends Error {
  readonly code=HELP_APP_API_ONEC_ERROR;
  readonly status=422;
  constructor(){
    super('Для живого чтения 1С используй личные инструменты и защищённое подключение пользователя.');
    this.name='HelpAppApiPersonalOnecRequiredError';
  }
}
const requests=new AsyncLocalStorage<{userId:number;onBlocked?:(error:HelpAppApiPersonalOnecRequiredError)=>void}>();

/** Set only after verification of the broker's signed JWT. No global switch,
 * cookie, request body or unsigned header can establish this context. */
export function runHelpAppApiRequest<T>(userId:number,next:()=>T,onBlocked?:(error:HelpAppApiPersonalOnecRequiredError)=>void):T {
  return requests.run({userId,onBlocked},next);
}

/** Cached APP data needs no exception: this runs only at shared-live transport. */
export function assertNoSharedOnecForHelpApi():void {
  const context=requests.getStore();if(!context)return;
  const error=new HelpAppApiPersonalOnecRequiredError();
  try{context.onBlocked?.(error);}catch{/* A finished response never permits the network request. */}
  throw error;
}
