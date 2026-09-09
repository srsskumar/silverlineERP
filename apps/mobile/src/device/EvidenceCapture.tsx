import {useRef,useState} from 'react';
import {Modal,Pressable,ScrollView,Text,TextInput,View,useWindowDimensions} from 'react-native';
import {File} from 'expo-file-system';
import {getEmployeesMe,getProjects,type Task} from '../api/endpoints';
import {enqueueOp} from '../sync/queue';
import {syncNow} from '../sync/engine';
import {useStyles} from '../ui';
import {getPunchFix} from './location';
import {CameraView,EvidenceWatermarkView,useEvidenceCamera,type BurnedEvidence} from './camera';

export function EvidenceCapture({task,onClose,onSaved}:{task:Task;onClose:()=>void;onSaved:(message:string)=>void}){
  const S=useStyles();
  const camera=useEvidenceCamera(),size=useWindowDimensions();
  const [busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[village,setVillage]=useState('');
  const burned=useRef<BurnedEvidence|null>(null);
  const close=()=>{if(busy)return;camera.discardStaged();if(burned.current)remove(burned.current.uri);onClose();};
  const capture=async()=>{
    setBusy(true);setError('');setReady(false);
    try{
      const [employee,fix,projects]=await Promise.all([getEmployeesMe(),getPunchFix(),getProjects()]);
      const project=projects.find(p=>p.id===task.project_id);
      await camera.capture({name:employee.full_name??employee.name??[employee.first_name,employee.last_name].filter(Boolean).join(' '),empNo:String(employee.emp_no??employee.employee_no??''),latitude:fix.latitude,longitude:fix.longitude,accuracy:fix.accuracy,timestamp:new Date().toISOString(),projectSite:project?.name??task.title,village:village.trim()||String(employee.village_name??'')});
    }catch(e){setError(e instanceof Error?e.message:'Capture failed');}finally{setBusy(false);}
  };
  const save=async()=>{
    setBusy(true);setError('');
    try{
      const photo=burned.current??await camera.burnStaged();burned.current=photo;
      const content=await new File(photo.uri).base64();
      await enqueueOp({entity:'task_evidence',op:`evidence:${task.id}:${photo.sha256}`,payload:{task_id:task.id,evidence_type:'photo',file_name:photo.fileName,content_base64:content,watermark:photo.watermark}});
      remove(photo.uri);burned.current=null;
      void syncNow();onSaved('Photo saved securely on this device. Check the sync queue for upload status.');
    }catch(e){setError(e instanceof Error?e.message:'Could not save photo');}finally{setBusy(false);}
  };
  const photo=camera.pendingPhoto;
  return <Modal visible animationType="slide" onRequestClose={close}><ScrollView style={[S.screen,{paddingTop:40}]}>
    <Text style={S.h1}>Task evidence</Text>
    <Text style={S.body}>{task.title}</Text>
    {photo?<EvidenceWatermarkView key={photo.uri} photoUri={photo.uri} photoWidth={photo.width} photoHeight={photo.height} watermark={photo.watermark} viewRef={camera.watermarkViewRef} layoutWidth={Math.min(size.width-32,320)} onReady={()=>setReady(true)}/>:burned.current?<Text style={S.muted}>Photo prepared. Retry saving it below.</Text>:camera.permission?.granted?<><TextInput style={S.input} placeholder="Village / site" accessibilityLabel="Village or site" value={village} onChangeText={setVillage}/><View style={{height:360,marginTop:12}}><CameraView ref={camera.cameraRef} facing="back" style={{flex:1}}/></View><Pressable disabled={busy} style={S.btn} onPress={()=>void capture()}><Text style={S.btnText}>{busy?'Capturing GPS and photo…':'Capture photo'}</Text></Pressable></>:<Pressable style={S.btn} onPress={()=>void camera.requestPermission()}><Text style={S.btnText}>Allow camera access</Text></Pressable>}
    {(photo||burned.current)?<Pressable style={S.btn} disabled={busy||(!ready&&!burned.current)} onPress={()=>void save()}><Text style={S.btnText}>{busy?'Saving…':'Save and upload when online'}</Text></Pressable>:null}
    {error?<Text accessibilityRole="alert" style={S.error}>{error}</Text>:null}
    <Pressable disabled={busy} style={S.btnGhost} onPress={close}><Text style={S.btnGhostText}>Cancel</Text></Pressable>
  </ScrollView></Modal>;
}
function remove(uri:string){try{const file=new File(uri);if(file.exists)file.delete();}catch{/* OS cache cleanup remains available. */}}
