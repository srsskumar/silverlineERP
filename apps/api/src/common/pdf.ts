/** Small paginated PDF writer using built-in Helvetica; monetary amounts use Rs. */
export function textPdf(title:string,lines:string[]):Buffer {
 const clean=(s:string)=>s.replace(/[^\x20-\x7e]/g,' ').replace(/([\\()])/g,'\\$1');
 const wrapped=lines.flatMap(line=>line.match(/.{1,88}(?:\s|$)|.{1,88}/g)??['']);
 const pages:string[][]=[];for(let n=0;n<Math.max(1,wrapped.length);n+=42)pages.push(wrapped.slice(n,n+42));
 const objects:string[]=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const ids:number[]=[];
 for(let index=0;index<pages.length;index++){
  const pageId=objects.length+1,streamId=pageId+1;ids.push(pageId);
  const stream=`BT /F1 18 Tf 50 790 Td (${clean(title)}) Tj /F1 10 Tf 0 -32 Td ${pages[index].map((l,i)=>`${i?'0 -16 Td ':''}(${clean(l)}) Tj`).join('\n')} 0 -24 Td (Page ${index+1} of ${pages.length}) Tj ET`;
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
 }
 objects[1]=`<< /Type /Pages /Kids [${ids.map(id=>`${id} 0 R`).join(' ')}] /Count ${ids.length} >>`;
 let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
 const start=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(pdf);
}
