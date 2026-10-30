import '../env';
import prisma,{pool} from '../prisma/client';
import { helpAssistantConfiguration, startHelpAssistantWorker } from '../modules/help/help.assistant';
if(!helpAssistantConfiguration().enabled){
  console.error('[help-ai] configure HELP_AI_ENABLED and a supported provider; simulator requires non-production NODE_ENV');
  process.exitCode=1;void prisma.$disconnect().finally(()=>pool.end());
}else {
  const stop=startHelpAssistantWorker();let shuttingDown=false;
  const shutdown=async()=>{
    if(shuttingDown)return;shuttingDown=true;
    // Drain the current step; on forced termination the persisted lease still recovers.
    const forced=setTimeout(()=>process.exit(1),70000);forced.unref();
    try{await stop();await prisma.$disconnect();await pool.end();clearTimeout(forced);process.exit(0);}
    catch{process.exit(1);}
  };
  process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
}
