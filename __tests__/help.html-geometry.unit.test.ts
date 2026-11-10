import {helpHtmlCompactHeight,helpHtmlAttachmentGeometry} from '../src/modules/help/help.html-geometry';
const fixed=(html:string,css='')=>helpHtmlCompactHeight({html,css});
test('root geometry honors cascade, bounds and a single root only',()=>{
 expect(fixed('<article id="x" class="c" style="height:180px">Example</article>','.c{height:240px!important}')).toBe(240);
 expect(fixed('<article id="x" class="c">Example</article>','#x{height:260px}.c{height:240px}')).toBe(260);
 expect(fixed('<article style="height:47px">Example</article>')).toBeUndefined();
 expect(fixed('<article style="height:1201px">Example</article>')).toBeUndefined();
 expect(fixed('<article><div style="height:100px">Example</div></article>')).toBeUndefined();
 expect(fixed('<article style="height:100px">One</article><p>Two</p>')).toBeUndefined();
 expect(fixed('<article class="c">One</article>','@media(min-width:300px){.c{height:100px}}')).toBeUndefined();
 expect(helpHtmlAttachmentGeometry({compact:{html:'<article>Square</article>',css:''}} as any)).toEqual({width:1,height:1});
});

test.each([[48,48],[48.01,49],[180.5,181],[1199.99,1200],[1200,1200]])('fractional CSS height %s reserves an integer viewport of %s without clipping', (height,expected)=>{
 const artifact={compact:{html:`<article style="height:${height}px">Example</article>`,css:''}} as any;
 const geometry=helpHtmlAttachmentGeometry(artifact);
 expect(geometry).toEqual({width:null,height:expected});
 expect(Number.isInteger(geometry.height)).toBe(true);expect(geometry.height).toBeGreaterThanOrEqual(height);
});
test.each([47.99,1200.01])('out-of-range fractional height %s stays square rather than being rounded into the accepted range', height=>{
 expect(helpHtmlAttachmentGeometry({compact:{html:`<article style="height:${height}px">Example</article>`,css:''}} as any)).toEqual({width:1,height:1});
});
