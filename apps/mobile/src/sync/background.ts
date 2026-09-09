import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import {syncNow} from './engine';
const TASK='silverline-offline-sync';
TaskManager.defineTask(TASK,async()=>{try{return await syncNow()?BackgroundTask.BackgroundTaskResult.Success:BackgroundTask.BackgroundTaskResult.Failed;}catch{return BackgroundTask.BackgroundTaskResult.Failed;}});
export async function registerBackgroundSync(){try{if(await TaskManager.isAvailableAsync()&&!(await TaskManager.isTaskRegisteredAsync(TASK)))await BackgroundTask.registerTaskAsync(TASK,{minimumInterval:15});}catch{/* Native development or store build required; foreground sync remains available. */}}
