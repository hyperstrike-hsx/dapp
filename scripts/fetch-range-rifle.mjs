import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// CC0 Poly Haven "Bolt Action Rifle 7.62" by Mateusz Sadek, retained locally so the range has no runtime dependency.
// The rifle itself uses 2K maps (it fills the first-person view); its accessories use 1K.
const asset='bolt_action_rifle_7_62',dir='apps/web/public/models/bolt-action-rifle';
const response=await fetch(`https://api.polyhaven.com/files/${asset}`);if(!response.ok)throw Error(`Asset metadata: ${response.status}`);
const {gltf}=await response.json();
const save=async(file,path)=>{
  const r=await fetch(file.url);if(!r.ok)throw Error(`Asset download: ${r.status}`);const buffer=Buffer.from(await r.arrayBuffer());
  if(createHash('md5').update(buffer).digest('hex')!==file.md5)throw Error('Asset integrity mismatch');
  await mkdir(`${dir}/${path}`.replace(/\/[^/]+$/,''),{recursive:true});await writeFile(`${dir}/${path}`,buffer);console.log(`${path}: ${buffer.length} bytes, verified`);return buffer;
};
let scene=(await save(gltf['2k'].gltf,'rifle.gltf')).toString('utf8');
for(const [path,file] of Object.entries(gltf['2k'].gltf.include)) if(!path.includes('accesories')) await save(file,path);
for(const [path,file] of Object.entries(gltf['1k'].gltf.include)) if(path.includes('accesories')) {await save(file,path);scene=scene.replaceAll(path.replace('_1k','_2k'),path);}
await writeFile(`${dir}/rifle.gltf`,scene);
