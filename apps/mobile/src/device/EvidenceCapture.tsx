import {useRef,useState} from 'react';
import {Modal,ScrollView,View,useWindowDimensions} from 'react-native';
import {File} from 'expo-file-system';
import {getEmployeesMe,getProjects,type Task} from '../api/endpoints';
import {enqueueOp} from '../sync/queue';
import {syncNow} from '../sync/engine';
import {Banner,Button,Input,Muted,Row} from '../ui/primitives';
import {radius,space,useTheme} from '../theme';
import {getPunchFix} from './location';
import {CameraView,EvidenceWatermarkView,useEvidenceCamera,type BurnedEvidence} from './camera';

export function EvidenceCapture({task,onClose,onSaved}:{task:Task;onClose:()=>void;onSaved:(message:string)=>void}){
  const theme=useTheme();
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
  return (
    <Modal visible animationType="slide" onRequestClose={close}>
      <View style={{flex:1,backgroundColor:theme.canvas}}>
        <Row style={{justifyContent:'space-between',paddingHorizontal:space.lg,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:theme.border,backgroundColor:theme.surface}}>
          <Muted style={{color:theme.text,fontWeight:'700'}}>Task evidence</Muted>
          <Button title="Cancel" variant="ghost" icon="close-outline" disabled={busy} onPress={close}/>
        </Row>
        <ScrollView contentContainerStyle={{padding:space.lg,paddingBottom:space.xxl*2}} keyboardShouldPersistTaps="handled">
          <Muted style={{marginBottom:space.md}}>{task.title}</Muted>

          {photo ? (
            <EvidenceWatermarkView
              key={photo.uri}
              photoUri={photo.uri}
              photoWidth={photo.width}
              photoHeight={photo.height}
              watermark={photo.watermark}
              viewRef={camera.watermarkViewRef}
              layoutWidth={Math.min(size.width - 32, 320)}
              onReady={() => setReady(true)}
            />
          ) : burned.current ? (
            <Banner tone="info" icon="image-outline" title="Photo prepared" message="Retry saving it below." />
          ) : camera.permission?.granted ? (
            <>
              <Input
                label="Village / site"
                accessibilityLabel="Village or site"
                placeholder="Where was this taken?"
                value={village}
                onChangeText={setVillage}
              />
              <View style={{height:360,marginTop:space.md,borderRadius:radius.lg,overflow:'hidden',backgroundColor:'#000'}}>
                <CameraView ref={camera.cameraRef} facing="back" style={{flex:1}}/>
              </View>
              <Button
                title={busy ? 'Capturing GPS and photo…' : 'Capture photo'}
                icon="camera-outline"
                loading={busy}
                disabled={busy}
                style={{marginTop:space.md}}
                onPress={()=>void capture()}
              />
            </>
          ) : (
            <Button title="Allow camera access" icon="lock-open-outline" onPress={()=>void camera.requestPermission()}/>
          )}

          {(photo||burned.current) ? (
            <Button
              title={busy ? 'Saving…' : 'Save and upload when online'}
              icon="save-outline"
              loading={busy}
              disabled={busy||(!ready&&!burned.current)}
              style={{marginTop:space.md}}
              onPress={()=>void save()}
            />
          ) : null}

          {error ? <View style={{marginTop:space.md}}><Banner tone="danger" icon="alert-circle-outline" title={error}/></View> : null}
        </ScrollView>
      </View>
    </Modal>
  );

}
function remove(uri:string){try{const file=new File(uri);if(file.exists)file.delete();}catch{/* OS cache cleanup remains available. */}}
