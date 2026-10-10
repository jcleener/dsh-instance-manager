import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../code/client.js', import.meta.url), 'utf8');
let bundle, cleanup, registrations = [];
const head = { appendChild(node) { node.parentNode = head; }, removeChild(node) { node.parentNode = null; } };
const document = { head, createElement(tag) { assert.equal(tag,'style'); return { dataset:{}, remove(){head.removeChild(this);} }; } };
const react = {
  createElement(type, props, ...children) { return { type, props:props||{}, children }; },
  useState(initial) { return [initial, () => {}]; },
  useRef(initial) { return {current:initial}; },
  useEffect(effect) { const dispose=effect(); dispose?.(); },
};
const context = {
  effect(factory) { cleanup = factory(); },
  inject(names, callback) {
    assert.deepEqual([...names], ['slots']);
    callback({ slots:{
      inject(key, callback) { assert.ok(['sidebar.footer.action','settings.section'].includes(key)); callback(); },
      register(definition, component) { registrations.push({definition,component}); return () => {}; },
    } });
  },
};
vm.runInNewContext(source, {window:{__ModuleLoader__:{load(x){bundle=x;}}},document,
  fetch: async () => ({ok:true,status:200,json:async()=>({ok:true,installed:true,running:true,daemon:{phase:'idle'}})}),
  setInterval:()=>123, clearInterval:()=>{}, setTimeout:()=>123,clearTimeout:()=>{},console}, {filename:'client.js'});
assert.equal(bundle.id,'dsh-instance-manager');
const exports=bundle.factory(name=>{assert.equal(name,'react');return react;});
assert.deepEqual([...exports.inject],['slots']);
exports.apply(context);
assert.equal(registrations.length,2);
for(const item of registrations) {
  const rendered=item.component({wide:true});
  assert.equal(typeof rendered.type,'function');
  const body=rendered.type(rendered.props);
  assert.equal(body.type,item.definition.name==='sidebar.footer.action'?'button':'div');
}
assert.ok(typeof cleanup==='function');
cleanup();
console.log('client-activate-ok (2 slots + React render + CSS cleanup)');
