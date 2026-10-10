import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../code/client.js', import.meta.url), 'utf8');
let bundle, footer, confirmCount = 0, confirmed = false;
const requests = [];
let hook = 0;
const react = {
  createElement(type, props, ...children) { return {type,props:props||{},children}; },
  useState(initial) { const index=hook++; return [index===0 ? {ok:true,installed:true,running:true,daemon:{phase:'idle'}} : initial, () => {}]; },
  useEffect() { /* 隔离测试不启动轮询 */ },
};
const head = { appendChild() {} };
const document = {head,createElement(){return {dataset:{},remove(){}};}};
const context = { effect(fn){fn();},inject(names,fn){assert.deepEqual([...names],['slots']);fn({slots:{
  inject(name,contribute){ if(name==='sidebar.footer.action') contribute(); },
  register(definition,renderer){footer=renderer;return ()=>{};},
}});} };
vm.runInNewContext(source,{window:{__ModuleLoader__:{load(x){bundle=x;}},confirm(message){confirmCount++;assert.match(message,/正在运行的任务/);return confirmed;}},document,console,
  fetch:async (url,options)=>{requests.push({url,method:options?.method||'GET'});return {ok:true,status:200,json:async()=>({ok:true,installed:true,running:true,status:{phase:'scheduled'}})};},
  setInterval(){return 1;},clearInterval(){}},{filename:'client.js'});
bundle.factory(name=>{assert.equal(name,'react');return react;}).apply(context);
assert.equal(typeof footer,'function');
const element=footer({wide:true});
const button=element.type(element.props);
assert.equal(button.type,'button');
assert.equal(button.props.disabled,false);
await button.props.onClick();
assert.equal(confirmCount,1);
assert.equal(requests.filter(x=>x.method==='POST').length,0,'取消时不得发送重启请求');
confirmed=true;
await button.props.onClick();
assert.equal(confirmCount,2);
assert.deepEqual(requests.filter(x=>x.method==='POST').map(x=>x.url),['/dsh-instance-manager/action']);
console.log('client-confirm-ok (cancel=0 POST; confirm=1 POST)');
