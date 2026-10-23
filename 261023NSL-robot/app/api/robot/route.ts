import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {handleRobot} from '@/lib/robot-api';
import {createRobotProviders} from '@/lib/robot-providers';
import type {RobotEnv} from '@/lib/robot-types';
export const dynamic='force-dynamic';
async function handle(request:Request){return handleRobot(request,env as RobotEnv,createRobotProviders(env),await getChatGPTUser()!==null);}
export const GET=handle;
export const POST=handle;
