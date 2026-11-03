#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Native pnpm composition, pure builds and ordinary npm downstream consumption."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
root=Path(__file__).resolve().parent.parent
system=subprocess.check_output(['nix','eval','--impure','--raw','--expr','builtins.currentSystem'],text=True).strip()
snapshot=json.loads(subprocess.check_output(['nix','flake','metadata','--json','--no-write-lock-file','path:'+str(root)],text=True))['path']
with tempfile.TemporaryDirectory(prefix='pnpm-native-composition-') as temporary:
    temporary=Path(temporary)
    subprocess.run(['nix-store','--add-root',str(temporary/'source'),'--realise',snapshot],check=True)
    cli=Path(subprocess.check_output(['nix','build',str(root)+'#cli','--out-link',str(temporary/'cli'),'--print-out-paths'],text=True).strip())/'bin/pnpm-purifier'
    env=dict(os.environ,PNPM_COMPOSITION_FLAKE=snapshot)
    sdk_expr='let f=builtins.getFlake ("path:"+builtins.getEnv "PNPM_COMPOSITION_FLAKE"); in f.inputs.nixpkgs.legacyPackages.'+system+'.nodejs'
    sdk=Path(subprocess.check_output(['nix','build','--impure','--expr',sdk_expr,'--out-link',str(temporary/'sdk'),'--print-out-paths'],env=env,text=True).strip())
    env.update(PATH=str(sdk/'bin')+':'+env['PATH'],npm_config_update_notifier='false',NO_COLOR='1')
    env.pop('FORCE_COLOR',None)
    project=temporary/'project'
    project.mkdir()
    manifest={'name':'pnpm-composed','version':'1.0.0','license':'MIT','type':'module','packageManager':'pnpm@12.9.0',
              'bin':{'pnpm-composed':'index.js'},'dependencies':{'@example/greet':'>=99'}}
    (project/'package.json').write_text(json.dumps(manifest))
    (project/'index.js').write_text('#!/usr/bin/env node\nimport {greet} from "@example/greet";console.log(greet("composed"));\n')
    original=(project/'package.json').read_bytes()
    def run(*args,**kwargs):
        return subprocess.run([str(arg) for arg in args],cwd=project,env=env,check=True,**kwargs)
    run(cli,'lock','--input','path:'+snapshot+'#checks.'+system+'.composition-producer')
    lockfile=project/'pnpm-purifier.lock.json'
    lock=json.loads(lockfile.read_text())
    assert len(lock['projectInputs'])==1 and not lock['artifacts']
    before=lockfile.read_bytes(),(project/'pnpm-lock.yaml').read_bytes()
    run(cli,'lock')
    assert before==(lockfile.read_bytes(),(project/'pnpm-lock.yaml').read_bytes())
    run(cli,'install','--frozen-lockfile','--store-dir',temporary/'fresh-store')
    output=run(cli,'exec','node','index.js',capture_output=True,text=True).stdout
    assert 'Hello, composed!' in output,output
    assert (project/'node_modules/@example/greet/built.txt').read_text()=='built by gen.js\n'
    assert (project/'package.json').read_bytes()==original
    # A committed lock may come from a platform with different Nix outputs.
    # Rebind in a temporary copy and leave both committed files unchanged.
    import hashlib
    import re
    text=(project/'pnpm-lock.yaml').read_text()
    text=re.sub(r'/nix/store/[^/]+/tarballs/[a-f0-9]+\.tgz',
                '/nix/store/'+'0'*32+'-absent/tarballs/'+'0'*64+'.tgz',text)
    text=re.sub(r'nix\.h[a-f0-9]{64}','nix.h'+'0'*64,text)
    (project/'pnpm-lock.yaml').write_text(text)
    lock['pnpmLockHash']=hashlib.sha256(text.encode()).hexdigest()
    lock.pop('contentHash')
    lock['contentHash']=hashlib.sha256(json.dumps(lock,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    lockfile.write_text(json.dumps(lock,indent=2)+'\n')
    before=lockfile.read_bytes(),(project/'pnpm-lock.yaml').read_bytes()
    run(cli,'install','--frozen-lockfile','--store-dir',temporary/'rebound-store')
    assert before==(lockfile.read_bytes(),(project/'pnpm-lock.yaml').read_bytes())
    env['PNPM_COMPOSITION_PROJECT']=str(project)
    expression='''let f=builtins.getFlake ("path:"+builtins.getEnv "PNPM_COMPOSITION_FLAKE");
      p=import f.inputs.nixpkgs {overlays=[f.overlays.default];};
    in p.pnpm-purifier.buildPnpmProject {src=/. + builtins.getEnv "PNPM_COMPOSITION_PROJECT";}'''
    def build(attribute):
        return Path(subprocess.check_output(['nix','build','--impure','--expr','('+expression+').'+attribute,
            '--out-link',str(temporary/attribute.replace('.','-')),'--print-out-paths'],env=env,text=True).strip())
    installed=build('packages.pnpm-composed')
    assert 'Hello, composed!' in subprocess.check_output([str(installed/'bin/pnpm-composed')],env=env,text=True)
    external=temporary/'external'
    external.mkdir()
    external_manifest={**manifest,'name':'external-composed','bin':{'external-composed':'index.js'}}
    (external/'package.json').write_text(json.dumps(external_manifest))
    (external/'index.js').write_bytes((project/'index.js').read_bytes())
    external_lock='''lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      '@example/greet':
        specifier: '>=99'
        version: 99.0.0
packages:
  '@example/greet@99.0.0':
    resolution: {integrity: sha512-DUMMY, tarball: https://invalid.example/greet-99.tgz}
snapshots:
  '@example/greet@99.0.0': {}
'''.replace('DUMMY',base64.b64encode(bytes(64)).decode())
    (external/'pnpm-lock.yaml').write_text(external_lock)
    external_expression='''let
      f=builtins.getFlake ("path:"+builtins.getEnv "PNPM_COMPOSITION_FLAKE");
      p=import f.inputs.nixpkgs {overlays=[f.overlays.default];};
      project=p.pnpm-purifier.buildPnpmProject {
        src=/. + builtins.getEnv "PNPM_EXTERNAL_PROJECT";
        dependencies=[f.checks.${builtins.currentSystem}.composition-producer];
      };
    in assert project.fetches == []; project.packages.external-composed'''
    external_env=dict(env,PNPM_EXTERNAL_PROJECT=str(external))
    external_output=Path(subprocess.check_output(['nix','build','--impure','--expr',external_expression,
        '--out-link',str(temporary/'external-output'),'--print-out-paths'],env=external_env,text=True).strip())
    assert 'Hello, composed!' in subprocess.check_output([str(external_output/'bin/external-composed')],env=env,text=True)
    assert (external/'pnpm-lock.yaml').read_text()==external_lock
    repository=build('release.projections.npm')
    catalog_path=subprocess.check_output(['nix','eval','--impure','--raw','--expr','('+expression+').release.projections.npm.catalog'],env=env,text=True).strip()
    modules=json.loads(Path(catalog_path).read_text())['modules']
    assert {item['name'] for item in modules}=={'pnpm-composed','@example/greet','picocolors'},'unrelated workspace dependencies leaked into projection'
    provided=next(item for item in modules if item['name']=='@example/greet')
    uploads={provided['name']:(repository/provided['archive']).read_bytes()}
    put_names=[]
    class Registry(BaseHTTPRequestHandler):
        def do_GET(self):
            route=unquote(urlsplit(self.path).path).lstrip('/')
            if route.startswith('tarballs/'):
                body=(repository/route).read_bytes()
            else:
                available=[item for item in modules if item['name']==route and item['name'] in uploads]
                if not available:
                    self.send_error(404)
                    return
                versions={item['version']:{**item['package'],'dist':{'tarball':'http://'+self.headers['Host']+'/'+item['archive'],'integrity':item['integrity']}} for item in available}
                body=json.dumps({'name':route,'versions':versions,'dist-tags':{'latest':available[0]['version']}}).encode()
            self.send_response(200)
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_PUT(self):
            document=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            put_names.append(document['name'])
            uploads[document['name']]=base64.b64decode(next(iter(document['_attachments'].values()))['data'])
            self.send_response(201)
            self.end_headers()
            self.wfile.write(b'{}')
        def log_message(self,*args): pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Registry)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    url='http://127.0.0.1:'+str(server.server_port)+'/'
    auth=temporary/'npmrc'
    auth.write_text('//127.0.0.1:'+str(server.server_port)+'/:_authToken=local-fixture\n')
    env.update(npm_config_userconfig=str(auth),pnpm_config_userconfig=str(auth))
    try:
        run(cli,'publish','--registry',url,'--access','public')
        assert provided['name'] not in put_names, 'an already published Nix dependency was uploaded again'
        for item in modules:
            assert uploads[item['name']]==(repository/item['archive']).read_bytes(),item['name']
        ordinary=temporary/'ordinary'
        ordinary.mkdir()
        (ordinary/'package.json').write_text('{"name":"ordinary-consumer","private":true}')
        version=next(item['version'] for item in modules if item['name']=='pnpm-composed')
        subprocess.run([str(sdk/'bin/npm'),'install','--no-audit','--no-fund','--registry',url,'--cache',str(temporary/'ordinary-cache'),'pnpm-composed@'+version],cwd=ordinary,env=env,check=True)
        assert 'Hello, composed!' in subprocess.check_output([str(ordinary/'node_modules/.bin/pnpm-composed')],env=env,text=True)
    finally:
        server.shutdown()
        server.server_close()
    assert before==(lockfile.read_bytes(),(project/'pnpm-lock.yaml').read_bytes())
    print('Native pnpm composition, pure build, exact publication and ordinary npm downstream passed')
