/** Query routes can be served directly by a static host for every database ID. */
export function staticHref(href:string):string {
 const patterns:[RegExp,string][]=[
  [/^\/projects\/([^/]+)\/tasks\/([^/?]+)$/,'task'],
  [/^\/projects\/([^/?]+)\/board$/,'board'],
  [/^\/attendance\/records\/([^/?]+)$/,'attendance'],
  [/^\/employees\/([^/?]+)$/,'employee'],[/^\/leave\/([^/?]+)$/,'leave'],[/^\/payroll\/([^/?]+)$/,'payroll'],[/^\/projects\/([^/?]+)$/,'project'],
 ];
 for(const [pattern,type] of patterns){const m=href.match(pattern);if(!m||['new','import','balances','exceptions'].includes(m[1]))continue;
  return `/record?${new URLSearchParams({type,id:m[2]??m[1],...(m[2]?{project:m[1]}:{})})}`;
 }
 return href;
}
