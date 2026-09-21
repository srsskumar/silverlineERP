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

/**
 * Where the board's view switch goes.
 *
 * The list is the project's own page -- there is no /projects/[id]/tasks
 * route, only /projects/[id]/tasks/[taskId] -- and on the static host a
 * project page is served through /record, so the address goes through
 * staticHref like every other link to a record. Built by hand, it was a 404.
 */
export function boardViewHref(projectId:string,view:'board'|'list'):string {
 return staticHref(view==='board'?`/projects/${projectId}/board`:`/projects/${projectId}`);
}
