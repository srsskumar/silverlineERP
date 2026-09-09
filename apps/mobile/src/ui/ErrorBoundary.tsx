import {Component,type ReactNode} from 'react';
import {Pressable,Text,View} from 'react-native';
import {reportClientError} from '../device/diagnostics';
import {useStyles} from '../ui';
function Recovery({retry}:{retry:()=>void}){const S=useStyles();return <View style={[S.screen,{justifyContent:'center'}]}><Text style={S.h1}>This screen could not open</Text><Text style={S.body}>Your saved changes remain on this device. Try opening the screen again.</Text><Pressable style={S.btn} onPress={retry}><Text style={S.btnText}>Try again</Text></Pressable></View>;}
export class AppErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:Error){void reportClientError(error);}
 render(){return this.state.failed?<Recovery retry={()=>this.setState({failed:false})}/>:this.props.children;}
}
