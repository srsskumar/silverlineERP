import {seal,unseal} from '../device/vault';
import {randomUUID} from 'expo-crypto';
import {ApiError} from '../api/client';
import {getDb,getAccount} from './db';
import {createQueue} from './queueCore';
import {surveyEntryChain} from './surveyEntryOp';
export type {QueueEntity,OpExecutor,FlushResult} from './queueCore';
export const {enqueueOp,flushQueue,rewriteOp,retryOp,discardOp,listOps,readPayload}=createQueue({getDb,getAccount,seal,unseal,uuid:randomUUID,isApiError:(e):e is ApiError=>e instanceof ApiError,chains:{survey_entry:surveyEntryChain}});
