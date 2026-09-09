import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Pressable,Text,TextInput} from 'react-native';
import {File,Paths} from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {randomUUID} from 'expo-crypto';
import {apiFetch,asItem,ApiError} from '../api/client';
import {Card,useStyles} from '../ui';
import {useAuth} from '../auth/AuthContext';
export function clearPayslipFiles(){try{for(const file of Paths.cache.list())if(file instanceof File&&file.name.startsWith('silverline-payslip-'))file.delete();}catch{/* cache may be unavailable during first launch */}}
export function Payslip(){
 const S=useStyles(),{permissions}=useAuth(),[month,setMonth]=useState(new Date().toISOString().slice(0,7)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const valid=/^\d{4}-(0[1-9]|1[0-2])$/.test(month);
 const q=useQuery({queryKey:['my-payslip',month],enabled:valid&&permissions.includes('payslip.read'),retry:false,queryFn:async()=>{const [y,m]=month.split('-').map(Number),end=`${month}-${new Date(y,m,0).getDate()}`;const result=await apiFetch<Record<string,any>>(`/api/v1/payslips/me?period_start=${month}-01&period_end=${end}`);return asItem<Record<string,any>>(result.data);}});
 if(!permissions.includes('payslip.read'))return null;
 async function download(){if(!q.data)return;setBusy(true);setError('');let file:File|undefined;try{
  if(!await Sharing.isAvailableAsync())throw new Error('File export is unavailable on this device.');
  const {data}=await apiFetch<Uint8Array>(`/api/v1/payroll/payslips/${q.data.id}/pdf`);
  file=new File(Paths.cache,`silverline-payslip-${randomUUID()}.pdf`);file.create();file.write(data);await Sharing.shareAsync(file.uri,{mimeType:'application/pdf',dialogTitle:'Save your payslip',UTI:'com.adobe.pdf'});
 }catch(e){setError(e instanceof Error?e.message:'Payslip download failed.');}finally{if(file?.exists)file.delete();setBusy(false);}}
 return <Card title="My payslip"><Text style={S.muted}>Period (YYYY-MM)</Text><TextInput accessibilityLabel="Payslip month" style={S.input} value={month} onChangeText={setMonth} maxLength={7}/>{q.isLoading?<Text style={S.muted}>Loading payslip…</Text>:null}{q.error?<Text style={S.muted}>{q.error instanceof ApiError&&q.error.status===404?'No payslip for this period.':'Connect to load your payslip.'}</Text>:null}{q.data?<><Text style={S.body}>Net pay: ₹{String(q.data.net_pay??'—')}</Text><Text style={S.muted}>{String(q.data.run_status??q.data.status??'')} · Version {String(q.data.version)}</Text><Pressable disabled={busy} style={S.btnGhost} onPress={()=>void download()}><Text style={S.btnGhostText}>{busy?'Preparing PDF…':'Save approved payslip PDF'}</Text></Pressable></>:null}{error?<Text style={S.muted}>{error}</Text>:null}</Card>;
}
