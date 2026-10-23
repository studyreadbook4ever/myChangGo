export type RobotLanguage='ko'|'en'|'ja'|'zh';
export type RobotStage='queued'|'ready'|'en_route'|'arrived'|'completed'|'needs_staff';
export type RobotMessage={
  id:string;role:'user'|'assistant';text:string;koText?:string;createdAt:string;
  origin:'prepare'|'followup';commentNeeded?:boolean;needsStaff?:boolean;
};
export type RobotJob={
  id:string;sourceId:string;type:'order.created'|'service.requested';table:string;language:RobotLanguage;
  originalText:string;koreanText:string;data:Record<string,unknown>;
  stage:RobotStage;version:number;prepared:boolean;preparationStatus:'pending'|'ready'|'failed';
  messages:RobotMessage[];needsStaff:boolean;receivedAt:string;updatedAt:string;
  latestError:{code:string;message:string}|null;
};
export type RobotCapabilities={speech:boolean;translation:boolean;chat:boolean;tts:boolean;audioStored:false;physicalControl:false};
export type RobotEnv={
  DB:D1Database;WEBHOOK_SECRET?:string;OPERATOR_TOKEN?:string;STAFF_OWNER_EMAIL?:string;
  CLOVA_SPEECH_INVOKE_URL?:string;CLOVA_SPEECH_SECRET?:string;PAPAGO_CLIENT_ID?:string;PAPAGO_CLIENT_SECRET?:string;
  CLOVA_STUDIO_API_KEY?:string;CLOVA_STUDIO_MODEL?:string;CLOVA_VOICE_CLIENT_ID?:string;CLOVA_VOICE_CLIENT_SECRET?:string;
  ROBOT_DAILY_AI_LIMIT?:string;
};
export type RobotProviders={
  status:()=>{speech:boolean;translation:boolean;chat:boolean;tts:boolean};
  transcribe:(input:{buffer:Uint8Array;mimeType:string;language:RobotLanguage})=>Promise<string>;
  translate:(input:{text:string;source:RobotLanguage;target:RobotLanguage})=>Promise<string>;
  respond:(input:{kind:'prepare'|'followup';job:{type:string;table:string;language:RobotLanguage;stage:RobotStage;data:Record<string,unknown>};textKo?:string;originalText?:string;history?:RobotMessage[]})=>Promise<{commentNeeded:boolean;replyKo:string;needsStaff:boolean}>;
  synthesize:(input:{text:string;language:RobotLanguage})=>Promise<Uint8Array>;
};
export class RobotError extends Error{
  constructor(public status:number,public code:string,message:string){super(message);this.name='RobotError';}
}
