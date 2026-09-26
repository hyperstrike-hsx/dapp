import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// CC0 Poly Haven source maps, retained locally so rendering has no external dependency.
for(const asset of (process.argv.length > 2 ? process.argv.slice(2) : ['brick_wall_001','concrete_floor_worn_001'])) {
  const response=await fetch(`https://api.polyhaven.com/files/${asset}`);if(!response.ok)throw Error(`Asset metadata: ${response.status}`);
  const files=await response.json(),dir=`apps/web/public/textures/${asset}-2k`;await mkdir(dir,{recursive:true});
  for(const [source,name] of [['Diffuse','diffuse'],['nor_gl','normal-gl'],['Rough','roughness'],['AO','ao']]) {
    const file=files[source]['2k'].jpg,r=await fetch(file.url);if(!r.ok)throw Error(`Asset download: ${r.status}`);const buffer=Buffer.from(await r.arrayBuffer());
    if(createHash('md5').update(buffer).digest('hex')!==file.md5)throw Error('Asset integrity mismatch');
    await writeFile(`${dir}/${name}.jpg`,buffer);console.log(`${asset}/${name}: ${buffer.length} bytes, verified`);
  }
}
