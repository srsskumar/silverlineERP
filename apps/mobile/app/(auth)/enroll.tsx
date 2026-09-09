import {useState} from 'react';
import {ScrollView,Text,TextInput,Pressable} from 'react-native';
import {apiFetch} from '../../src/api/client';
import {useAuth} from '../../src/auth/AuthContext';
import {Card,useStyles} from '../../src/ui';
export default function Enroll(){
  const S=useStyles();const {logout}=useAuth(),[secret,setSecret]=useState(''),[code,setCode]=useState(''),[message,setMessage]=useState('');return <ScrollView style={S.screen}><Card title="Secure your account"><Text style={S.body}>Your role requires an authenticator. Add the setup key to your authenticator app, then enter its six-digit code.</Text>{secret?<><Text selectable style={S.body}>{secret}</Text><TextInput style={S.input} keyboardType="number-pad" value={code} onChangeText={setCode} placeholder="Authentication code"/><Pressable style={S.btn} onPress={()=>void apiFetch('/api/v1/auth/mfa/verify',{method:'POST',body:{code}}).then(()=>logout()).catch(e=>setMessage(e.message))}><Text style={S.btnText}>Enable and sign in again</Text></Pressable></>:<Pressable style={S.btn} onPress={()=>void apiFetch<{secret:string}>('/api/v1/auth/mfa/setup',{method:'POST',body:{}}).then(r=>setSecret(r.data.secret)).catch(e=>setMessage(e.message))}><Text style={S.btnText}>Set up authenticator</Text></Pressable>}<Text style={S.error}>{message}</Text></Card></ScrollView>;}
