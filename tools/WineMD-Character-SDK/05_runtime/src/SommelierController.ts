import {GESTURE_VALUE,MODE_VALUE,EMOTION_VALUE,SommelierEvent} from "./types";
export interface RiveInputAdapter { setNumber(name:string,value:number):void; fire(name:string):void; }
export class SommelierController {
  private activeGenerationId:string|null=null;
  constructor(private readonly rive:RiveInputAdapter){}
  apply(event:SommelierEvent):void {
    if(this.activeGenerationId && event.generationId!==this.activeGenerationId) return;
    this.activeGenerationId ??= event.generationId;
    if(event.mode) this.rive.setNumber("mode",MODE_VALUE[event.mode]);
    if(event.gesture) this.rive.setNumber("gesture",GESTURE_VALUE[event.gesture]);
    if(event.emotion) this.rive.setNumber("emotion",EMOTION_VALUE[event.emotion]);
    if(typeof event.mouth==="number") this.rive.setNumber("mouth",event.mouth);
    if(event.blink) this.rive.fire("blink");
  }
  endGeneration(id:string):void {
    if(this.activeGenerationId!==id) return;
    this.rive.setNumber("mode",MODE_VALUE.idle); this.rive.setNumber("gesture",GESTURE_VALUE.none); this.rive.setNumber("mouth",0); this.activeGenerationId=null;
  }
}
