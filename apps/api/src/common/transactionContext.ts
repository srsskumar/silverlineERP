import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient} from 'pg';

const transactions=new AsyncLocalStorage<{pool:Pool;client:PoolClient}>();

/** Legacy read helpers share the current transaction instead of borrowing a second connection. */
export function transactionPool(raw:Pool):Pool{
 const pool=new Proxy(raw,{
  get(target,property){
   if(property==='query')return (...args:unknown[])=>{
    const context=transactions.getStore(),db=context?.pool===pool?context.client:target;
    return (db.query as (...args:unknown[])=>unknown).apply(db,args);
   };
   const value=Reflect.get(target,property,target);
   return typeof value==='function'?value.bind(target):value;
  },
 });
 return pool;
}

export function inTransaction<T>(pool:Pool,client:PoolClient,operation:()=>Promise<T>):Promise<T>{
 return transactions.run({pool,client},operation);
}
