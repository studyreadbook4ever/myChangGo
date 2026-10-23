import type { KioskEnv,Language,Providers } from './kiosk-types';
import { quota } from './kiosk-store';

type Job={source_id:string;client_hash:string;attempts:number;payload:string};
/** Foreign-language calls remain visible immediately. Delivery waits for the
 * Korean staff translation; the original text is never replaced or normalized. */
export async function flushKioskTranslations(env:KioskEnv,providers:Providers,sourceId?:string,client?:string) {
  const now=Date.now();
  const values:(string|number)[]=[now,now];if(sourceId)values.push(sourceId);if(client)values.push(client);
  const jobs=await env.DB.prepare(`SELECT j.source_id,j.client_hash,j.attempts,s.payload FROM kiosk_translation_jobs j JOIN kiosk_services s ON s.id=j.source_id
    WHERE j.status='pending' AND j.next_attempt_at<=? AND j.lease_until<=? ${sourceId?'AND j.source_id=?':''} ${client?'AND j.client_hash=?':''} ORDER BY j.next_attempt_at LIMIT 1`)
    .bind(...values).all<Job>();
  for(const job of jobs.results) {
    const owner=crypto.randomUUID();
    const claim=await env.DB.prepare(`UPDATE kiosk_translation_jobs SET lease_owner=?,lease_until=? WHERE source_id=? AND status='pending' AND lease_until<=? RETURNING source_id`).bind(owner,Date.now()+60000,job.source_id,Date.now()).first();
    if(!claim)continue;
    const data=JSON.parse(job.payload) as {id:string;naturalLanguage:string;language:Language;koreanText?:string;translationStatus?:string};
    try {
      await quota(env,job.client_hash);
      const koreanText=await providers.translate({text:data.naturalLanguage,source:data.language,target:'ko'});
      if(!koreanText.trim()||koreanText.length>16000)throw new Error('Invalid translation.');
      data.koreanText=koreanText;data.translationStatus='complete';
      const pending=await env.DB.prepare("SELECT id,payload FROM kiosk_outbox WHERE source_id=? AND status='translation_pending'").bind(job.source_id).all<{id:string;payload:string}>();
      await env.DB.batch([
        env.DB.prepare('UPDATE kiosk_services SET payload=? WHERE id=? AND EXISTS(SELECT 1 FROM kiosk_translation_jobs WHERE source_id=? AND lease_owner=?)').bind(JSON.stringify(data),job.source_id,job.source_id,owner),
        ...pending.results.map(row=>env.DB.prepare(`UPDATE kiosk_outbox SET payload=?,status='queued',next_attempt_at=? WHERE id=? AND status='translation_pending' AND EXISTS(SELECT 1 FROM kiosk_translation_jobs WHERE source_id=? AND lease_owner=?)`).bind(JSON.stringify({...JSON.parse(row.payload),data}),Date.now(),row.id,job.source_id,owner)),
        env.DB.prepare('DELETE FROM kiosk_translation_jobs WHERE source_id=? AND lease_owner=?').bind(job.source_id,owner),
      ]);
    } catch {
      const attempts=job.attempts+1,failed=attempts>=3;data.translationStatus=failed?'failed':'pending';
      await env.DB.batch([
        env.DB.prepare('UPDATE kiosk_services SET payload=? WHERE id=? AND EXISTS(SELECT 1 FROM kiosk_translation_jobs WHERE source_id=? AND lease_owner=?)').bind(JSON.stringify(data),job.source_id,job.source_id,owner),
        env.DB.prepare('UPDATE kiosk_translation_jobs SET status=?,attempts=?,next_attempt_at=?,lease_owner=NULL,lease_until=0 WHERE source_id=? AND lease_owner=?').bind(failed?'failed':'pending',attempts,Date.now()+60000,job.source_id,owner),
      ]);
    }
  }
}
