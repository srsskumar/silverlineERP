import {seal,unseal} from '../device/vault';
import {randomUUID} from 'expo-crypto';
import {ApiError} from '../api/client';
import {getDb,getAccount} from './db';
import {createQueue} from './queueCore';
export type {QueueEntity,OpExecutor,FlushResult} from './queueCore';
export const {enqueueOp,flushQueue,retryOp,discardOp,listOps}=createQueue({getDb,getAccount,seal,unseal,uuid:randomUUID,isApiError:(e):e is ApiError=>e instanceof ApiError});
