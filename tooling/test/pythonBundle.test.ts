import {mkdtemp,mkdir,readFile,rm,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {describe,it,expect} from 'vitest';
import {candidatePins,buildPythonBundle} from '../python-bundle/build.mjs';
describe('developer Python bundle boundary',()=>{
  it('records exact candidate release assets without enabling a production bundle',async()=>{
    const pins=await candidatePins();expect(pins.status).toBe('development-candidate');expect(pins.assets).toHaveLength(5);
    for(const pin of pins.assets){expect(pin.url.startsWith('https://github.com/astral-sh/python-build-standalone/releases/download/20261026/')).toBe(true);expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);expect(pin.runtime_version).toBe('3.13.18');expect(pin.bytes).toBeGreaterThan(0);expect(pin.bytes).toBeLessThan(64*1024*1024);}
  });
  it('requires explicit archive or download before creating output',async()=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'extalia-python-build-'));
    try{const out=path.join(dir,'result');await expect(buildPythonBundle({target:'macos-aarch64',out})).rejects.toThrow();await expect(access(out)).rejects.toThrow();await expect(buildPythonBundle({target:'unknown',out,archive:path.join(dir,'missing')})).rejects.toThrow();await expect(access(out)).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
  });
  it('never overwrites existing output and cleans only a newly reserved failed output',async()=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'extalia-python-build-'));
    try{const out=path.join(dir,'result');await mkdir(out);await writeFile(path.join(out,'marker'),'keep');const options={target:'macos-aarch64',out,archive:path.join(dir,'missing')};await expect(buildPythonBundle(options)).rejects.toThrow();expect(await readFile(path.join(out,'marker'),'utf8')).toBe('keep');await expect(buildPythonBundle({...options,out:path.join(dir,'failed')})).rejects.toThrow();await expect(access(path.join(dir,'failed'))).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
  });
});
