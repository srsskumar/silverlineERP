'use client';
import {useQuery} from '@tanstack/react-query';
import {apiRequest} from '@/lib/apiClient';
import {MutationForm,type Row} from './Workbench';
import {ErrorCard} from '../ui/ErrorCard';
export function NotificationPreferences(){const q=useQuery({queryKey:['notification-preferences'],queryFn:async()=>(await apiRequest<Row>('/api/v1/auth/preferences')).data});if(q.error)return <ErrorCard error={q.error}/>;if(!q.data)return <p>Loading preferences…</p>;return <MutationForm path="auth/preferences" method="PATCH" key={JSON.stringify(q.data)} initial={q.data.notification_preferences} fields={[{key:'push',label:'Push notifications',type:'checkbox'},{key:'sms',label:'SMS notifications when the service is configured',type:'checkbox'},{key:'whatsapp',label:'WhatsApp notifications when the service is configured',type:'checkbox'}]} transform={v=>({push:!!v.push,sms:!!v.sms,whatsapp:!!v.whatsapp})} submit="Save notification preferences"/>;}
