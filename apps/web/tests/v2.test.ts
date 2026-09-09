import {describe,it,expect,vi,afterEach} from 'vitest';
import {staticHref} from '../lib/routes';
import {apiRequest,loginRequest,setTokens,__resetAuthStateForTests} from '../lib/apiClient';
afterEach(()=>{vi.unstubAllGlobals();__resetAuthStateForTests();});
describe('release navigation',()=>{
 it('routes real records to static pages without changing creation routes',()=>{
  expect(staticHref('/employees/new')).toBe('/employees/new');
  expect(staticHref('/employees/abc')).toBe('/record?type=employee&id=abc');
  expect(staticHref('/projects/p/tasks/t')).toBe('/record?type=task&id=t&project=p');
  expect(staticHref('/projects/p/board')).toBe('/record?type=board&id=p');
 });
 it('sends the MFA code to the login step-up contract',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({access_token:'a',refresh_token:'r',mfa_required:false}),{status:200}));vi.stubGlobal('fetch',fetcher);
  await loginRequest('person','password','123456');const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url.endsWith('/auth/login')).toBe(true);expect(JSON.parse(String(init.body))).toEqual({username:'person',password:'password',totp_code:'123456'});
 });
 it('preserves a mutation key across token refresh and retry',async()=>{
  setTokens('old','refresh');const seen:Record<string,string>[]=[];let n=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{if(url.endsWith('/refresh'))return new Response(JSON.stringify({access_token:'new',refresh_token:'new-r'}),{status:200});seen.push(init.headers as Record<string,string>);return new Response(JSON.stringify(n++?{ok:true}:{code:'EXPIRED',message:'Expired'}),{status:n===1?401:200});}));
  await apiRequest('/api/v1/tasks',{method:'POST',body:{title:'Once'}});expect(seen).toHaveLength(2);expect(seen[0]['Idempotency-Key']).toBe(seen[1]['Idempotency-Key']);
 });
});
