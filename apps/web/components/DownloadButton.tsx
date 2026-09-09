'use client';
import {useState} from 'react';
import {downloadFile} from '@/lib/apiClient';
import {Button} from './ui/Button';
import {ErrorCard} from './ui/ErrorCard';
export function DownloadButton({path,name,label}:{path:string;name:string;label:string}){const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>();return <><Button loading={busy} onClick={async()=>{setBusy(true);setError(undefined);try{await downloadFile(path,name);}catch(e){setError(e);}finally{setBusy(false);}}}>{label}</Button>{error?<ErrorCard error={error}/>:null}</>;}
