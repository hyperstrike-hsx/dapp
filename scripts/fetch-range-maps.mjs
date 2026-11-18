import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// CC0 Poly Haven sources for the selectable range maps, retained locally so rendering
// has no external dependency. Every file is checked against the API's content MD5.
const TEXTURES=[['sandstone_cracks','2k'],['cobblestone_floor_04','2k'],['painted_plaster_wall','1k'],['asphalt_02','1k']];
const SKIES=[['goegap','2k'],['tears_of_steel_bridge','2k'],['rooftop_night','2k']];
const MAPS=[['Diffuse','diffuse'],['nor_gl','normal-gl'],['Rough','roughness']];
const save=async(file,path,label)=>{
  const response=await fetch(file.url);if(!response.ok)throw Error(`Asset download: ${response.status}`);
  const buffer=Buffer.from(await response.arrayBuffer());
  if(createHash('md5').update(buffer).digest('hex')!==file.md5)throw Error('Asset integrity mismatch');
  await writeFile(path,buffer);console.log(`${label}: ${buffer.length} bytes, verified`);return buffer.length;
};
const files=async(asset)=>{const response=await fetch(`https://api.polyhaven.com/files/${asset}`);if(!response.ok)throw Error(`Asset metadata: ${response.status}`);return response.json();};
let total=0;
for(const [asset,size] of TEXTURES){
  const meta=await files(asset),dir=`apps/web/public/textures/${asset}-${size}`;await mkdir(dir,{recursive:true});
  for(const [source,name] of MAPS)total+=await save(meta[source][size].jpg,`${dir}/${name}.jpg`,`${asset}/${name}`);
}
await mkdir('apps/web/public/environment',{recursive:true});
for(const [asset,size] of SKIES){
  const meta=await files(asset);
  total+=await save(meta.hdri[size].hdr,`apps/web/public/environment/${asset}-${size}.hdr`,asset);
}
console.log(`total ${(total/1048576).toFixed(1)} MB`);
