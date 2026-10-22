/* Chloe AI engine. Shared by the web page and the server. The host must provide fmt(x). */
function avgRange(cs,i,n){var s=0,k=0;for(var j=Math.max(0,i-n+1);j<=i;j++){s+=cs[j].h-cs[j].l;k++}return s/k}

/* ---------- price-action engine (no indicators) ---------- */
function pivots(cs,i){
  var hs=[],ls=[],a=Math.max(3,i-100);
  for(var j=a;j<=i-3;j++){
    var ph=true,pl=true;
    for(var k=1;k<=3;k++){
      if(!(cs[j].h>cs[j-k].h&&cs[j].h>=cs[j+k].h))ph=false;
      if(!(cs[j].l<cs[j-k].l&&cs[j].l<=cs[j+k].l))pl=false;
    }
    if(ph)hs.push({i:j,v:cs[j].h});
    if(pl)ls.push({i:j,v:cs[j].l});
  }
  return {hs:hs,ls:ls};
}
function trendOf(pv){
  var h=pv.hs,l=pv.ls;
  if(h.length<2||l.length<2)return 'range';
  var hh=h[h.length-1].v>h[h.length-2].v,hl=l[l.length-1].v>l[l.length-2].v;
  if(hh&&hl)return 'bullish';
  if(!hh&&!hl)return 'bearish';
  return 'range';
}
function dedupe(a,asc,price){
  a.sort(function(x,y){return asc?x-y:y-x});
  var out=[];a.forEach(function(v){if(!out.length||Math.abs(v-out[out.length-1])>price*0.0005)out.push(v)});
  return out;
}
function levelsOf(pv,price){
  var res=pv.hs.map(function(p){return p.v}).filter(function(v){return v>price});
  var sup=pv.ls.map(function(p){return p.v}).filter(function(v){return v<price});
  return {res:dedupe(res,true,price),sup:dedupe(sup,false,price)};
}
function patterns(cs,i){
  var a=cs[i-1],b=cs[i],body=Math.abs(b.c-b.o),rng=(b.h-b.l)||1e-9,lo=Math.min(b.o,b.c)-b.l,hi=b.h-Math.max(b.o,b.c),bull=null,bear=null;
  if(b.c>b.o&&a.c<a.o&&b.c>=a.o&&b.o<=a.c)bull='Bullish engulfing';
  else if(lo>=2*body&&lo>=0.55*rng&&(b.c-b.l)/rng>0.6)bull='Bullish pin bar (long lower wick)';
  if(b.c<b.o&&a.c>a.o&&b.c<=a.o&&b.o>=a.c)bear='Bearish engulfing';
  else if(hi>=2*body&&hi>=0.55*rng&&(b.h-b.c)/rng>0.6)bear='Bearish pin bar (long upper wick)';
  return {bull:bull,bear:bear};
}
function planAt(cs,i,pv,dir,entry){
  var c=cs[i],sgn=dir==='BUY'?1:-1,lv=levelsOf(pv,entry),rng=(c.h-c.l)||entry*0.0005,buf=0.25*rng,sl,base;
  if(sgn>0){var s0=lv.sup[0];base=s0!=null?Math.min(s0,c.l):c.l;sl=base-buf}
  else{var r0=lv.res[0];base=r0!=null?Math.max(r0,c.h):c.h;sl=base+buf}
  var dist=Math.abs(entry-sl);
  if(dist<entry*0.0003){dist=entry*0.0003;sl=entry-sgn*dist}
  var opp=sgn>0?lv.res:lv.sup,mult=[0.8,1.5,2.5],fall=[1,2,3],used=0,tps=[];
  for(var t=0;t<3;t++){
    var found=null;
    for(var q=used;q<opp.length;q++){if(Math.abs(opp[q]-entry)>=mult[t]*dist){found=opp[q];used=q+1;break}}
    tps.push(found!=null?{p:found,kind:'level'}:{p:entry+sgn*fall[t]*dist,kind:'R'});
  }
  tps.sort(function(a,b){return Math.abs(a.p-entry)-Math.abs(b.p-entry)});
  return {dir:dir,entry:entry,sl:sl,dist:dist,tps:tps,nearOpp:opp.length?opp[0]:null,sup:lv.sup[0],res:lv.res[0]};
}
var HTF={M1:[15,'M15'],M5:[12,'H1'],M15:[4,'H1'],H1:[4,'H4'],H4:[6,'D1'],D1:[5,'W1']};
function htfTrend(cs,i,tf){
  var f=(HTF[tf]||HTF.H4)[0],start=Math.max(0,i-f*40+1),sl=cs.slice(start,i+1),g=[];
  for(var e=sl.length;e>0;e-=f){var b=Math.max(0,e-f),h=-Infinity,l=Infinity;for(var k=b;k<e;k++){if(sl[k].h>h)h=sl[k].h;if(sl[k].l<l)l=sl[k].l}g.unshift({o:sl[b].o,h:h,l:l,c:sl[e-1].c})}
  if(g.length<9)return 'range';
  return trendOf(pivots(g,g.length-1));
}
function scoreAt(cs,i,bias,tf){
  var pv=pivots(cs,i),tr=trendOf(pv),c=cs[i],pt=patterns(cs,i),lv=levelsOf(pv,c.c);
  var lastH=pv.hs.length?pv.hs[pv.hs.length-1].v:null,lastL=pv.ls.length?pv.ls[pv.ls.length-1].v:null;
  var htfT=htfTrend(cs,i,tf),htfName=(HTF[tf]||HTF.H4)[1];
  var out={pv:pv,trend:tr,levels:lv,htf:htfT};
  ['BUY','SELL'].forEach(function(dir){
    var up=dir==='BUY',pl=planAt(cs,i,pv,dir,c.c),checks=[];
    checks.push([up?'Structure: higher highs and higher lows':'Structure: lower highs and lower lows',tr===(up?'bullish':'bearish')]);
    var mom=up?(c.c>cs[i-1].c&&cs[i-1].c>cs[i-2].c):(c.c<cs[i-1].c&&cs[i-1].c<cs[i-2].c);
    checks.push([up?'The last 3 closes are rising':'The last 3 closes are falling',mom]);
    var pat=up?pt.bull:pt.bear;
    checks.push([pat?pat+' on the last candle':(up?'No bullish candle pattern (engulfing or pin bar)':'No bearish candle pattern (engulfing or pin bar)'),!!pat]);
    var s0=lv.sup[0],r0=lv.res[0],keyOk=false,keyTxt;
    if(up){
      var low3=Math.min(cs[i].l,cs[i-1].l,cs[i-2].l);
      var near=s0!=null&&(r0!=null?(low3-s0)<=0.25*(r0-s0):(low3-s0)<=0.002*c.c);
      var brk=lastH!=null&&c.c>lastH;
      keyOk=near||brk;
      keyTxt=near?'Reacting from support near '+fmt(s0):(brk?'Closed above the latest swing high (breakout)':'Not at a key level (support is not being tested)');
    }else{
      var hi3=Math.max(cs[i].h,cs[i-1].h,cs[i-2].h);
      var nearR=r0!=null&&(s0!=null?(r0-hi3)<=0.25*(r0-s0):(r0-hi3)<=0.002*c.c);
      var brkD=lastL!=null&&c.c<lastL;
      keyOk=nearR||brkD;
      keyTxt=nearR?'Reacting from resistance near '+fmt(r0):(brkD?'Closed below the latest swing low (breakdown)':'Not at a key level (resistance is not being tested)');
    }
    checks.push([keyTxt,keyOk]);
    var ratio=pl.nearOpp!=null?Math.abs(pl.nearOpp-pl.entry)/pl.dist:null,room=pl.nearOpp==null||ratio>=1;
    checks.push([pl.nearOpp==null?'Open space to the next level':('Next '+(up?'resistance ':'support ')+fmt(pl.nearOpp)+' is '+ratio.toFixed(1)+'R away'+(room?'':', too close')),room]);
    var nOk=(up&&bias==='bullish')||(!up&&bias==='bearish');
    checks.push([nOk?'News view agrees ('+bias+')':'News view is '+bias+', so it does not confirm',nOk]);
    var hOk=htfT===(up?'bullish':'bearish');
    checks.push([hOk?'Higher timeframe ('+htfName+') trend agrees: '+htfT:'Higher timeframe ('+htfName+') trend is '+htfT+', which does not agree',hOk]);
    out[dir]={checks:checks,score:checks.filter(function(x){return x[1]}).length,plan:pl};
  });
  return out;
}
function decide(o,min,block){
  var b=o.BUY,s=o.SELL,lean=b.score>=s.score?'BUY':'SELL',sel=o[lean];
  var dir=(!block&&sel.score>=min&&b.score!==s.score)?lean:'WAIT';
  return {dir:dir,lean:lean,score:sel.score,checks:sel.checks,plan:sel.plan,trend:o.trend,htf:o.htf,levels:o.levels,pv:o.pv,block:block};
}
function backtestOn(cs,tf,th,ti,cost){
  var R=[],i=30;
  while(i<cs.length-2){
    var sg=decide(scoreAt(cs,i,'neutral',tf),th,false);
    if(sg.dir==='WAIT'){i++;continue}
    var entry=cs[i+1].o,pl=planAt(cs,i,sg.pv,sg.dir,entry),sgn=sg.dir==='BUY'?1:-1,tp=pl.tps[ti].p;
    if((tp-entry)*sgn<=0||(entry-pl.sl)*sgn<=0){i++;continue}
    var rr=Math.abs(tp-entry)/pl.dist,res=null,j;
    for(j=i+1;j<cs.length;j++){
      var b=cs[j],hitSL=sgn>0?b.l<=pl.sl:b.h>=pl.sl,hitTP=sgn>0?b.h>=tp:b.l<=tp;
      if(hitSL){res=-1;break}
      if(hitTP){res=rr;break}
    }
    if(res===null)break;
    R.push(res-cost);i=j+1;
  }
  return R;
}

/* ===== indicators (confirmation only), line-chart structure, smart-money detectors, strategies ===== */
function atrAt(cs,i,n){var s=0,k=0;for(var j=Math.max(1,i-n+1);j<=i;j++){var a=cs[j],p=cs[j-1];s+=Math.max(a.h-a.l,Math.abs(a.h-p.c),Math.abs(a.l-p.c));k++}return k?s/k:0}
function emaAt(cs,i,n){var k=2/(n+1),st=Math.max(0,i-n*4),e=cs[st].c;for(var j=st+1;j<=i;j++)e=cs[j].c*k+e*(1-k);return e}
function rsiAt(cs,i,n){
  var st=Math.max(1,i-n*6),ag=0,al=0,j,d;
  if(i<n+1)return 50;
  for(j=st;j<st+n&&j<=i;j++){d=cs[j].c-cs[j-1].c;if(d>0)ag+=d;else al-=d}
  ag/=n;al/=n;
  for(;j<=i;j++){d=cs[j].c-cs[j-1].c;ag=(ag*(n-1)+(d>0?d:0))/n;al=(al*(n-1)+(d<0?-d:0))/n}
  return al===0?100:100-100/(1+ag/al);
}
function linePivots(cs,i){
  var hs=[],ls=[],a=Math.max(3,i-100);
  for(var j=a;j<=i-3;j++){
    var ph=true,pl=true;
    for(var k=1;k<=3;k++){
      if(!(cs[j].c>cs[j-k].c&&cs[j].c>=cs[j+k].c))ph=false;
      if(!(cs[j].c<cs[j-k].c&&cs[j].c<=cs[j+k].c))pl=false;
    }
    if(ph)hs.push({i:j,v:cs[j].c});
    if(pl)ls.push({i:j,v:cs[j].c});
  }
  return {hs:hs,ls:ls};
}
function indConfirm(cs,i,dir){
  var up=dir==='BUY',c=cs[i].c,e20=emaAt(cs,i,20),e50=emaAt(cs,i,50),r=rsiAt(cs,i,14),a14=atrAt(cs,i,14),a50=atrAt(cs,i,50),lt=trendOf(linePivots(cs,i)),items=[];
  var emaOk=up?(c>e20&&e20>e50):(c<e20&&e20<e50);
  items.push([emaOk?'EMA 20/50 agree: price and fast average are '+(up?'above':'below')+' the slow one':'EMA 20/50 do not agree with a '+(up?'buy':'sell'),emaOk]);
  var rOk=up?(r>50&&r<75):(r<50&&r>25);
  items.push(['RSI(14) is '+r.toFixed(0)+(rOk?', momentum supports a '+(up?'buy':'sell'):((up?r>=75:r<=25)?(up?', overbought, chasing risk':', oversold, chasing risk'):', momentum is not behind it')),rOk]);
  var aOk=a50>0&&a14>=0.8*a50;
  items.push([aOk?'Volatility (ATR) is healthy for a move':'Volatility (ATR) is low, so moves may stall',aOk]);
  var lOk=lt===(up?'bullish':'bearish');
  items.push(['Line chart (closing prices) structure is '+lt+(lOk?', which agrees':', which does not agree'),lOk]);
  return {n:items.filter(function(x){return x[1]}).length,total:4,items:items,rsi:r,line:lt};
}
function fvgList(cs,i,atr,look){
  var out=[];
  for(var k=Math.max(2,i-look);k<=i;k++){
    var a=cs[k-2],c=cs[k];
    if(a.h<c.l&&(c.l-a.h)>=0.3*atr)out.push({kind:'FVG',dir:'BUY',lo:a.h,hi:c.l,i:k-1});
    else if(a.l>c.h&&(a.l-c.h)>=0.3*atr)out.push({kind:'FVG',dir:'SELL',lo:c.h,hi:a.l,i:k-1});
  }
  return out.filter(function(g){for(var j=g.i+2;j<=i;j++){if(g.dir==='BUY'?cs[j].c<g.lo:cs[j].c>g.hi)return false}return true}).reverse();
}
function orderBlocks(cs,i,pv){
  var out=[],seen={};
  pv.hs.forEach(function(p){
    var j=-1,k;for(k=p.i+1;k<=i;k++){if(cs[k].c>p.v){j=k;break}}
    if(j<0)return;
    var ob=-1;for(k=j-1;k>=Math.max(0,p.i-5);k--){if(cs[k].c<cs[k].o){ob=k;break}}
    if(ob<0||seen['b'+ob]||i-ob>80)return;
    var z={kind:'OB',dir:'BUY',lo:cs[ob].l,hi:Math.max(cs[ob].o,cs[ob].c),i:ob,brk:j},ok=true;
    for(k=j+1;k<=i;k++){if(cs[k].c<z.lo){ok=false;break}}
    if(ok){seen['b'+ob]=1;out.push(z)}
  });
  pv.ls.forEach(function(p){
    var j=-1,k;for(k=p.i+1;k<=i;k++){if(cs[k].c<p.v){j=k;break}}
    if(j<0)return;
    var ob=-1;for(k=j-1;k>=Math.max(0,p.i-5);k--){if(cs[k].c>cs[k].o){ob=k;break}}
    if(ob<0||seen['s'+ob]||i-ob>80)return;
    var z={kind:'OB',dir:'SELL',lo:Math.min(cs[ob].o,cs[ob].c),hi:cs[ob].h,i:ob,brk:j},ok=true;
    for(k=j+1;k<=i;k++){if(cs[k].c>z.hi){ok=false;break}}
    if(ok){seen['s'+ob]=1;out.push(z)}
  });
  out.sort(function(a,b){return b.i-a.i});
  return out.slice(0,6);
}
function smcState(cs,i){
  var pv0=pivots(cs,Math.max(10,i-8)),tr0=trendOf(pv0),lh=pv0.hs[pv0.hs.length-1],ll=pv0.ls[pv0.ls.length-1],ev=null;
  for(var j=Math.max(1,i-7);j<=i;j++){
    if(lh&&cs[j].c>lh.v){ev={dir:'BUY',kind:tr0==='bullish'?'BOS':'CHoCH',lvl:lh.v,i:j};break}
    if(ll&&cs[j].c<ll.v){ev={dir:'SELL',kind:tr0==='bearish'?'BOS':'CHoCH',lvl:ll.v,i:j};break}
  }
  var bias=ev?ev.dir:(tr0==='bullish'?'BUY':(tr0==='bearish'?'SELL':null));
  return {bias:bias,ev:ev,trend:tr0};
}
function sweepAt(cs,i,pv){
  for(var j=i;j>=i-1;j--){
    for(var q=pv.hs.length-1;q>=Math.max(0,pv.hs.length-6);q--){var p=pv.hs[q];if(p.i<j-3&&cs[j].h>p.v&&cs[j].c<p.v)return {dir:'SELL',lvl:p.v,wick:cs[j].h,i:j}}
    for(q=pv.ls.length-1;q>=Math.max(0,pv.ls.length-6);q--){var r=pv.ls[q];if(r.i<j-3&&cs[j].l<r.v&&cs[j].c>r.v)return {dir:'BUY',lvl:r.v,wick:cs[j].l,i:j}}
  }
  return null;
}
function planWith(cs,i,pv,dir,entry,sl){
  var sgn=dir==='BUY'?1:-1;
  if((entry-sl)*sgn<=0)return null;
  var lv=levelsOf(pv,entry),dist=Math.abs(entry-sl);
  if(dist<entry*0.0003){dist=entry*0.0003;sl=entry-sgn*dist}
  var opp=sgn>0?lv.res:lv.sup,mult=[0.8,1.5,2.5],fall=[1,2,3],used=0,tps=[];
  for(var t=0;t<3;t++){
    var found=null;
    for(var q=used;q<opp.length;q++){if(Math.abs(opp[q]-entry)>=mult[t]*dist){found=opp[q];used=q+1;break}}
    tps.push(found!=null?{p:found,kind:'level'}:{p:entry+sgn*fall[t]*dist,kind:'R'});
  }
  tps.sort(function(a,b){return Math.abs(a.p-entry)-Math.abs(b.p-entry)});
  return {dir:dir,entry:entry,sl:sl,dist:dist,tps:tps,nearOpp:opp.length?opp[0]:null,sup:lv.sup[0],res:lv.res[0]};
}
function ctxAt(cs,i,tf,bias){
  var pv=pivots(cs,i),c=cs[i];
  return {pv:pv,tr:trendOf(pv),atr:atrAt(cs,i,14)||(c.h-c.l),lv:levelsOf(pv,c.c),htf:htfTrend(cs,i,tf),pt:patterns(cs,i),c:c,bias:bias,st:smcState(cs,i)};
}
var STRATS=[
  {id:'pa',name:'Price action',blurb:'Market structure, candle patterns, key levels and room to the next level. Seven plain checks.'},
  {id:'smc',name:'Smart money (SMC)',blurb:'Break of structure or change of character, then price returns to an unmitigated order block or fair value gap and reacts.'},
  {id:'sr',name:'Support and resistance',blurb:'A rejection candle (pin bar or engulfing) at a proven swing level, trading the bounce.'},
  {id:'trend',name:'Trend pullback',blurb:'In a clear trend, buy or sell the 30 to 75 percent pullback once price turns back in trend direction.'},
  {id:'break',name:'Breakout and retest',blurb:'Price closes through a swing level, comes back to retest it, and holds.'},
  {id:'sweep',name:'Liquidity sweep',blurb:'Price spikes through a swing high or low to take stops, closes back inside, and a confirming candle follows.'},
  {id:'line',name:'Line-chart structure',blurb:'Structure read from closing prices only (line chart): trend in closes plus a fresh break of the last closing swing.'},
  {id:'crt',name:'CRT (range sweep)',blurb:'5 minute entries only. The last 4 hour candle is the range; price sweeps its high or low, closes back inside, a displacement candle follows, and the target is the middle of the range.'},
  {id:'ema',name:'EMA pullback',blurb:'Swing (1 and 4 hour). 20, 50 and 200 averages stacked in one direction, price dips to the 20 average and closes back out in the trend direction.'}
];
function stratName(id){for(var k=0;k<STRATS.length;k++)if(STRATS[k].id===id)return STRATS[k].name;return id}
function zonesFor(cs,i,x){
  var f=fvgList(cs,i,x.atr,60),o=orderBlocks(cs,i,x.pv);
  return o.concat(f).sort(function(a,b){return b.i-a.i}).slice(0,6);
}
function evalStrat(id,cs,i,x,dir){
  var up=dir==='BUY',c=x.c,atr=x.atr,conds=[],sl=null,zones=[],lv=x.lv,pv=x.pv,hs=pv.hs,ls=pv.ls,lh=hs[hs.length-1],ll=ls[ls.length-1],pat=up?x.pt.bull:x.pt.bear,sgn=up?1:-1;
  if(id==='smc'){
    var st=x.st,zs=zonesFor(cs,i,x),hit=null;
    zones=zs;
    conds.push([st.bias===dir?'Structure: '+(st.ev&&st.ev.dir===dir?st.ev.kind+' '+(up?'up':'down')+' through '+fmt(st.ev.lvl):(up?'bullish':'bearish')+' trend'):'Structure does not support a '+(up?'buy':'sell')+' (bias '+(st.bias||'none')+')',st.bias===dir]);
    zs.forEach(function(z){if(hit||z.dir!==dir)return;var lo2=Math.min(c.l,i>0?cs[i-1].l:c.l),hi2=Math.max(c.h,i>0?cs[i-1].h:c.h);if(up?(lo2<=z.hi&&c.c>=z.lo):(hi2>=z.lo&&c.c<=z.hi))hit=z});
    conds.push([hit?'Price returned to a '+(up?'bullish':'bearish')+' '+(hit.kind==='OB'?'order block':'fair value gap')+' '+fmt(hit.lo)+' to '+fmt(hit.hi):'Price is not inside an unmitigated '+(up?'bullish':'bearish')+' order block or fair value gap',!!hit]);
    var rx=up?c.c>c.o:c.c<c.o;
    conds.push([rx?'Reaction candle closed '+(up?'up':'down')+' from the zone':'No reaction candle yet',rx]);
    if(hit)sl=up?hit.lo-0.25*atr:hit.hi+0.25*atr;
  }else if(id==='sr'){
    var lvl=up?lv.sup[0]:lv.res[0],near=false;
    if(lvl!=null){var ext=up?Math.min(c.l,cs[i-1].l):Math.max(c.h,cs[i-1].h);near=up?(ext<=lvl+0.3*atr&&c.c>lvl):(ext>=lvl-0.3*atr&&c.c<lvl)}
    conds.push([near?'Price is at '+(up?'support ':'resistance ')+fmt(lvl):'Price is not at a proven '+(up?'support':'resistance')+' level',near]);
    conds.push([pat?pat+' rejecting the level':'No rejection candle (pin bar or engulfing)',!!pat]);
    var held=lvl!=null&&(up?c.c>lvl:c.c<lvl);
    conds.push([held?'Closed back on the right side of the level':'Closed through the level',held]);
    if(near)sl=up?Math.min(lvl,c.l,cs[i-1].l)-0.25*atr:Math.max(lvl,c.h,cs[i-1].h)+0.25*atr;
  }else if(id==='trend'){
    conds.push([x.tr===(up?'bullish':'bearish')?'Trend: '+(up?'higher highs and higher lows':'lower highs and lower lows'):'No clear '+(up?'uptrend':'downtrend')+' (structure is '+x.tr+')',x.tr===(up?'bullish':'bearish')]);
    var okLeg=lh&&ll&&(up?ll.i<lh.i:lh.i<ll.i),retr=null,depth=false;
    if(okLeg){var leg=Math.abs(lh.v-ll.v);retr=up?(lh.v-c.l)/leg:(c.h-ll.v)/leg;depth=leg>0&&retr>=0.3&&retr<=0.75}
    conds.push([depth?'Pulled back '+Math.round(retr*100)+'% of the last swing':'Not in a 30 to 75% pullback of the last swing',depth]);
    var trig=pat||(up?c.c>cs[i-1].h:c.c<cs[i-1].l);
    conds.push([trig?(pat||'Closed beyond the previous candle')+', turning back with the trend':'No turn back in trend direction yet',!!trig]);
    if(okLeg)sl=up?ll.v-0.25*atr:lh.v+0.25*atr;
  }else if(id==='break'){
    var pv6=pivots(cs,Math.max(10,i-6)),l6=up?pv6.hs[pv6.hs.length-1]:pv6.ls[pv6.ls.length-1],brk=false,ret=false,hold=false;
    if(l6){
      for(var j=i-5;j<i;j++){if(up?cs[j].c>l6.v:cs[j].c<l6.v)brk=true}
      ret=brk&&(up?(c.l<=l6.v+0.3*atr&&c.l>=l6.v-0.8*atr):(c.h>=l6.v-0.3*atr&&c.h<=l6.v+0.8*atr));
      hold=ret&&(up?(c.c>l6.v&&c.c>c.o):(c.c<l6.v&&c.c<c.o));
    }
    conds.push([brk?'Closed '+(up?'above ':'below ')+fmt(l6.v)+' in the last 5 candles':'No recent close through a swing '+(up?'high':'low'),brk]);
    conds.push([ret?'Price came back to retest '+fmt(l6.v):'No retest of the broken level yet',ret]);
    conds.push([hold?'Retest held and closed '+(up?'up':'down'):'The retest has not held',hold]);
    if(ret)sl=up?Math.min(c.l,l6.v)-0.4*atr:Math.max(c.h,l6.v)+0.4*atr;
  }else if(id==='sweep'){
    var sw=sweepAt(cs,i,pv),ok=sw&&sw.dir===dir;
    conds.push([ok?'Liquidity taken: wick through '+fmt(sw.lvl)+' then closed back '+(up?'above':'below'):'No liquidity sweep of a swing '+(up?'low':'high')+' in the last 2 candles',!!ok]);
    var cf=up?c.c>c.o:c.c<c.o;
    conds.push([cf?'Confirming candle closed '+(up?'up':'down'):'Latest candle does not confirm',cf]);
    var big=ok&&Math.abs(sw.wick-sw.lvl)>=0.1*atr;
    conds.push([big?'The sweep was meaningful (more than 0.1 ATR)':'The sweep was too small to count',!!big]);
    if(ok)sl=up?sw.wick-0.25*atr:sw.wick+0.25*atr;
  }else if(id==='line'){
    var lp=linePivots(cs,i),lt=trendOf(lp),lhh=lp.hs[lp.hs.length-1],lll=lp.ls[lp.ls.length-1];
    conds.push([lt===(up?'bullish':'bearish')?'Closing-price line makes '+(up?'higher highs and higher lows':'lower highs and lower lows'):'Closing-price line is '+lt,lt===(up?'bullish':'bearish')]);
    var key=up?lhh:lll,fresh=false;
    if(key){fresh=up?(c.c>key.v&&Math.min(cs[i-1].c,cs[i-2].c)<=key.v):(c.c<key.v&&Math.max(cs[i-1].c,cs[i-2].c)>=key.v)}
    conds.push([fresh?'Line broke '+(up?'above ':'below ')+fmt(key.v)+' (last closing swing)':'No fresh break of the last closing swing',fresh]);
    var cf2=up?c.c>c.o:c.c<c.o;
    conds.push([cf2?'Break candle closed in direction':'Break candle does not confirm',cf2]);
    var other=up?lll:lhh;
    if(fresh&&other){var ext2=c.l;if(up){for(var m=other.i;m<=i;m++)ext2=Math.min(ext2,cs[m].l);sl=ext2-0.25*atr}else{ext2=c.h;for(m=other.i;m<=i;m++)ext2=Math.max(ext2,cs[m].h);sl=ext2+0.25*atr}}
  }
  return {conds:conds,sl:sl,zones:zones};
}
function wrapPA(d,i){
  return {id:'pa',name:'Price action',dir:d.dir,lean:d.lean,q:d.score/7,checks:d.checks,plan:d.plan,zones:[],score:d.score};
}

/* ---- CRT and EMA pullback (added after testing on gold 2025 vs 2026) ---- */
function tsOf(c){if(c._ts==null)c._ts=Date.parse(String(c.t).replace(' ','T')+'Z')/1000;return c._ts}
var CRT_PER=14400;
/* CRT (candle range theory), 5 minute entries inside the next 4 hour candle: the previous 4 hour candle is the range; price sweeps its high or low,
   closes back inside, then a candle closes beyond the signal candle (displacement). Target is the middle of the range. */
function crtEval(cs,i,tf){
  if(tf!=='M5'||i<60)return null;
  var t=tsOf(cs[i]),k2=Math.floor(t/CRT_PER),start=i,j,b,hh=(t%86400)/3600,wd=new Date(t*1000).getUTCDay();
  if(hh<7||hh>=20||wd<1||wd>5)return null; // tested in the London and New York session only
  while(start>0&&Math.floor(tsOf(cs[start-1])/CRT_PER)===k2)start--;
  var p=start-1;if(p<0||Math.floor(tsOf(cs[p])/CRT_PER)!==k2-1)return null;
  var H=-1e9,L=1e9,n=0,k1=k2-1;
  while(p>=0&&Math.floor(tsOf(cs[p])/CRT_PER)===k1){if(cs[p].h>H)H=cs[p].h;if(cs[p].l<L)L=cs[p].l;n++;p--}
  if(n<29)return null;
  var side=null,ext=0,trig=-1;
  for(j=start;j<=i;j++){b=cs[j];
    if(side==null){
      if(b.h>H&&b.l<L)return null;
      if(b.h>H){side='S';ext=b.h;if(b.c<H){trig=j;break}}
      else if(b.l<L){side='B';ext=b.l;if(b.c>L){trig=j;break}}
    }else if(side==='S'){ext=Math.max(ext,b.h);if(b.c<H){trig=j;break}}
    else{ext=Math.min(ext,b.l);if(b.c>L){trig=j;break}}
  }
  if(trig<0)return null;
  var sb=cs[trig],f=-1;
  for(j=trig+1;j<=i;j++){b=cs[j];if(side==='S'?b.c<sb.l:b.c>sb.h){f=j;break}if(side==='S'?b.h>ext:b.l<ext)return null}
  if(f!==i)return null;
  if(Math.floor((t+300)/CRT_PER)!==k2)return null;
  var up=side==='B',sgn=up?1:-1,atr=atrAt(cs,i,14)||(cs[i].h-cs[i].l),sext=ext;
  for(j=start;j<=i;j++){sext=up?Math.min(sext,cs[j].l):Math.max(sext,cs[j].h)}
  var en=cs[i].c,sl=sext-sgn*0.1*atr,mid=(H+L)/2,dist=Math.abs(en-sl),rr=(en-sl)*sgn>0&&(mid-en)*sgn>0&&dist>0?Math.abs(mid-en)/dist:0;
  var conds=[
    ['4 hour range '+fmt(L)+' to '+fmt(H)+': price swept the '+(up?'low':'high')+' to '+fmt(ext)+' and closed back inside',true],
    ['Displacement: a candle closed beyond the signal candle, in the '+(up?'buy':'sell')+' direction',true],
    [rr>=1?'Middle of the range '+fmt(mid)+' is '+rr.toFixed(1)+'R away':'Middle of the range is too close to the stop ('+rr.toFixed(1)+'R, need 1R)',rr>=1],
    [dist>=0.5*atr?'Stop is a sensible size':'Stop is under half an ATR, too small for the spread',dist>=0.5*atr]];
  var ok=conds.every(function(k){return k[1]});
  return {dir:up?'BUY':'SELL',conds:conds,ok:ok,en:en,sl:sl,mid:mid,dist:dist};
}
/* EMA pullback (swing): 20, 50 and 200 averages stacked in one direction, price dips to the 20 and closes back out in trend direction. */
function emaArr(cs){
  var c=cs._ema;if(c&&c.n===cs.length)return c.a;
  var a=[],e1=cs[0].c,e2=e1,e3=e1,k1=2/21,k2=2/51,k3=2/201;
  for(var j=0;j<cs.length;j++){if(j){var v=cs[j].c;e1=v*k1+e1*(1-k1);e2=v*k2+e2*(1-k2);e3=v*k3+e3*(1-k3)}a.push([e1,e2,e3])}
  try{Object.defineProperty(cs,'_ema',{value:{n:cs.length,a:a},writable:true,configurable:true,enumerable:false})}catch(e){}
  return a;
}
function emaEval(cs,i,tf){
  if((tf!=='H4'&&tf!=='H1'&&tf!=='D1')||i<210)return null;
  if(tf==='H1'){var h=new Date(tsOf(cs[i])*1000).getUTCHours();if(h<7||h>=20)return null}
  var E=emaArr(cs)[i],c=cs[i],up=null;
  if(E[1]>E[2]&&E[0]>E[1]&&c.l<=E[0]&&c.c>E[0]&&c.c>c.o)up=true;
  else if(E[1]<E[2]&&E[0]<E[1]&&c.h>=E[0]&&c.c<E[0]&&c.c<c.o)up=false;
  if(up==null)return null;
  var sgn=up?1:-1,atr=atrAt(cs,i,14)||(c.h-c.l),lo=Math.min(c.l,cs[i-1].l,cs[i-2].l),hi=Math.max(c.h,cs[i-1].h,cs[i-2].h),sl=up?lo-0.1*atr:hi+0.1*atr,en=c.c,dist=Math.abs(en-sl);
  var conds=[
    [(up?'Uptrend':'Downtrend')+': 20, 50 and 200 averages stacked '+(up?'upward':'downward'),true],
    ['Price dipped to the 20 average ('+fmt(E[0])+') and closed back '+(up?'above':'below')+' it, candle closed '+(up?'up':'down'),true],
    [dist<=3*atr&&(en-sl)*sgn>0?'Stop is '+(dist/atr).toFixed(1)+' ATR':'Stop would be wider than 3 ATR',dist<=3*atr&&(en-sl)*sgn>0]];
  return {dir:up?'BUY':'SELL',conds:conds,ok:conds.every(function(k){return k[1]}),en:en,sl:sl,dist:dist};
}
function runCustom(id,cs,i,tf){
  var e=id==='crt'?crtEval(cs,i,tf):emaEval(cs,i,tf),name=stratName(id);
  if(!e)return {id:id,name:name,dir:'WAIT',lean:'WAIT',q:0,checks:[[id==='crt'?'No sweep of the last 4 hour range with a displacement candle right now (needs the 5 minute chart)':'No pullback to the 20 average inside a clean trend right now (needs the 1 or 4 hour chart)',false]],plan:null,zones:[],score:0};
  if(!e.ok)return {id:id,name:name,dir:'WAIT',lean:e.dir,q:0.3,checks:e.conds,plan:null,zones:[],score:2};
  var sgn=e.dir==='BUY'?1:-1,lv=levelsOf(pivots(cs,i),e.en),tps;
  if(id==='crt')tps=[{p:e.mid,kind:'MID'},{p:e.mid,kind:'MID'},{p:e.mid,kind:'MID'}];
  else tps=[1.5,2,3].map(function(m){return {p:e.en+sgn*m*e.dist,kind:'R'}});
  var plan={dir:e.dir,entry:e.en,sl:e.sl,dist:e.dist,tps:tps,nearOpp:(sgn>0?lv.res:lv.sup)[0]!=null?(sgn>0?lv.res:lv.sup)[0]:null,sup:lv.sup[0],res:lv.res[0]};
  return {id:id,name:name,dir:e.dir,lean:e.dir,q:0.8,checks:e.conds,plan:plan,zones:[],score:6};
}
function runStrat(id,cs,i,tf,bias,minScore,x,paBase){
  if(id==='crt'||id==='ema')return runCustom(id,cs,i,tf);
  x=x||ctxAt(cs,i,tf,bias);
  if(id==='pa'){return wrapPA(paBase||decide(scoreAt(cs,i,bias,tf),minScore,false),i)}
  var best=null;
  ['BUY','SELL'].forEach(function(dir){
    var e=evalStrat(id,cs,i,x,dir);e.dir=dir;e.pass=e.conds.filter(function(k){return k[1]}).length;
    if(!best||e.pass>best.pass)best=e;
  });
  var all=best.conds.every(function(k){return k[1]})&&best.sl!=null,plan=all?planWith(cs,i,x.pv,best.dir,x.c.c,best.sl):null,up=best.dir==='BUY';
  var checks=best.conds.slice();
  if(plan){
    var ratio=plan.nearOpp!=null?Math.abs(plan.nearOpp-plan.entry)/plan.dist:null,room=plan.nearOpp==null||ratio>=1;
    checks.push([plan.nearOpp==null?'Open space to the next level':('Next '+(up?'resistance ':'support ')+fmt(plan.nearOpp)+' is '+ratio.toFixed(1)+'R away'+(room?'':', too close')),room]);
    var hOk=x.htf===(up?'bullish':'bearish');
    checks.push([hOk?'Higher timeframe ('+(HTF[tf]||HTF.H4)[1]+') trend agrees: '+x.htf:'Higher timeframe ('+(HTF[tf]||HTF.H4)[1]+') trend is '+x.htf+', which does not agree',hOk]);
    var nOk=(up&&bias==='bullish')||(!up&&bias==='bearish');
    checks.push([nOk?'News view agrees ('+bias+')':'News view is '+bias+', so it does not confirm',nOk]);
    var q=checks.filter(function(k){return k[1]}).length/checks.length,go=room&&q>=(minScore-1)/7;
    return {id:id,name:stratName(id),dir:go?best.dir:'WAIT',lean:best.dir,q:q,checks:checks,plan:go?plan:null,zones:best.zones,score:Math.round(q*7)};
  }
  return {id:id,name:stratName(id),dir:'WAIT',lean:best.dir,q:best.conds.length?best.pass/(best.conds.length+3):0,checks:checks,plan:null,zones:best.zones,score:0};
}
function statsOf(R){
  var n=R.length,w=R.filter(function(v){return v>0}).length,s=R.reduce(function(a,v){return a+v},0),gp=0,gl=0;
  R.forEach(function(v){if(v>0)gp+=v;else gl-=v});
  return {n:n,w:w,exp:n?s/n:0,sh:s/(n+5),sum:s,pf:gl>0?gp/gl:(gp>0?99:0)};
}
function execTrade(cs,i,dir,plan,ti,cost){
  var entry=cs[i+1].o,sgn=dir==='BUY'?1:-1,tp=plan.tps[ti].p;
  if((tp-entry)*sgn<=0||(entry-plan.sl)*sgn<=0)return {skip:true,j:i+1};
  var rr=Math.abs(tp-entry)/Math.abs(entry-plan.sl),j;
  for(j=i+1;j<cs.length;j++){
    var b=cs[j],hitSL=sgn>0?b.l<=plan.sl:b.h>=plan.sl,hitTP=sgn>0?b.h>=tp:b.l<=tp;
    if(hitSL)return {r:-1-cost,j:j};
    if(hitTP)return {r:rr-cost,j:j};
  }
  return {open:true,j:j};
}
function backtestStrat(cs,tf,id,ti,cost,minScore){
  var R=[],i=40,th=Math.min(minScore,5);
  while(i<cs.length-2){
    var r=runStrat(id,cs,i,tf,'neutral',th);
    if(r.dir==='WAIT'){i++;continue}
    var e=execTrade(cs,i,r.dir,r.plan,ti,cost);
    if(e.skip){i++;continue}
    if(e.open)break;
    R.push(e.r);i=e.j+1;
  }
  return R;
}
function confidenceOf(q,st,confirmN,near){
  var hist=((st?st.w:0)+2)/((st?st.n:0)+4),c=Math.round(100*(0.5*q+0.35*hist+0.15*confirmN/4));
  if(near)c-=10;
  return Math.max(5,Math.min(85,c));
}
/* Run every strategy on the latest candle, rank them by their own recent results, and pick one. mode: auto | combine | a strategy id */
function analyseAll(cs,tf,bias,mode,minScore,block,near){
  var i=cs.length-1,x=ctxAt(cs,i,tf,bias),paBase=decide(scoreAt(cs,i,bias,tf),minScore,false),res={},rank=[];
  STRATS.forEach(function(s){res[s.id]=runStrat(s.id,cs,i,tf,bias,minScore,x,paBase)});
  STRATS.forEach(function(s){
    var st=statsOf(s.id==='pa'?backtestOn(cs,tf,Math.min(minScore,6),1,0.05):backtestStrat(cs,tf,s.id,1,0.05,minScore));
    rank.push({id:s.id,name:s.name,n:st.n,w:st.w,exp:st.exp,sh:st.sh,pf:st.pf,dir:res[s.id].dir,q:res[s.id].q});
  });
  rank.sort(function(a,b){return b.sh-a.sh});
  var buys=0,sells=0;STRATS.forEach(function(s){if(res[s.id].dir==='BUY')buys++;else if(res[s.id].dir==='SELL')sells++});
  var chosen=null,why='';
  if(mode==='auto'){
    var act=rank.filter(function(r){return r.dir!=='WAIT'});
    if(act.length){var top=act[0];chosen=res[top.id];why='Auto picked '+top.name+' (best recent results among the strategies that have a setup now)'}
    else{chosen=res[rank[0].id];why='No strategy has a setup right now'}
  }else if(mode==='combine'){
    var maj=buys>=2&&buys>sells?'BUY':(sells>=2&&sells>buys?'SELL':null);
    if(maj){var cand=STRATS.map(function(s){return res[s.id]}).filter(function(r){return r.dir===maj}).sort(function(a,b){return b.q-a.q});chosen=cand[0];why=(maj==='BUY'?buys:sells)+' strategies agree on '+maj}
    else{chosen=res[rank[0].id];why='Fewer than 2 strategies agree'}
  }else{chosen=res[mode]||res.pa;why='You chose '+chosen.name}
  var cst=null;rank.forEach(function(r){if(r.id===chosen.id)cst=r});
  var conf=indConfirm(cs,i,chosen.dir==='WAIT'?chosen.lean:chosen.dir);
  var pct=confidenceOf(chosen.q,cst&&{w:cst.w,n:cst.n},conf.n,near);
  var o=paBase,active=chosen.dir!=='WAIT'&&!block;
  var sig={dir:active?chosen.dir:'WAIT',lean:chosen.lean||o.lean,score:chosen.id==='pa'?chosen.score:Math.round(chosen.q*7),checks:chosen.checks,plan:(chosen.plan||o.plan),trend:o.trend,htf:o.htf,levels:o.levels,pv:o.pv,block:block,
    zones:zonesFor(cs,i,x),strat:chosen.id,stratName:chosen.name,why:why,conf:pct,confN:cst?cst.n:0,confW:cst?cst.w:0,confirm:conf,rank:rank,buys:buys,sells:sells,near:!!near};
  return sig;
}
/* ---- scalping profile: same rules, lower timeframe, tighter stop, fixed small targets, extra filters ---- */
var SCALP_DEF={tf:'M5',slAtr:1.5,rr:[1,1.5,2.2],target:1,minConfirm:2,minScore:5,session:true,cost:0.1};
var SCALP_ORDER=['crt','smc','sweep','sr','trend','break','line','pa'];
function inSession(sym,ms){
  if(sym==='BTCUSD')return true;
  var d=new Date(ms||Date.now()),h=d.getUTCHours(),w=d.getUTCDay();
  return w>0&&w<6&&h>=7&&h<20;
}
function scalpPick(cs,i,tf,bias,o,x){
  x=x||ctxAt(cs,i,tf,bias);var lastFail='No strategy has a setup right now';
  for(var k=0;k<SCALP_ORDER.length;k++){
    var r=runStrat(SCALP_ORDER[k],cs,i,tf,bias,o.minScore,x);
    if(r.dir==='WAIT'||!r.plan)continue;
    if(r.id==='crt'){var cfc=indConfirm(cs,i,r.dir);return {ok:true,id:r.id,name:r.name,dir:r.dir,q:r.q,checks:r.checks.concat(cfc.items),plan:r.plan,confirm:cfc,why:'CRT range sweep with displacement, target the middle of the 4 hour range'}}
    var atr=x.atr,dist=r.plan.dist;
    if(dist>o.slAtr*atr){lastFail=r.name+': stop is '+(dist/atr).toFixed(1)+' ATR, wider than the '+o.slAtr+' ATR scalp limit';continue}
    var cf=indConfirm(cs,i,r.dir);
    if(cf.n<o.minConfirm){lastFail=r.name+': only '+cf.n+' of 4 confirmations agree (need '+o.minConfirm+')';continue}
    if(x.htf===(r.dir==='BUY'?'bearish':'bullish')){lastFail=r.name+': higher timeframe trend is against it';continue}
    var sgn=r.dir==='BUY'?1:-1,en=r.plan.entry,tps=o.rr.map(function(m){return {p:en+sgn*m*dist,kind:'R'}});
    var plan={dir:r.dir,entry:en,sl:r.plan.sl,dist:dist,tps:tps,nearOpp:r.plan.nearOpp,sup:r.plan.sup,res:r.plan.res};
    return {ok:true,id:r.id,name:r.name,dir:r.dir,q:r.q,checks:r.checks.concat(cf.items),plan:plan,confirm:cf,why:r.name+' setup passed the scalp filters'};
  }
  return {ok:false,dir:'WAIT',why:lastFail};
}
function scalpBacktest(cs,tf,o){
  var R=[],i=60;
  while(i<cs.length-2){
    var r=scalpPick(cs,i,tf,'neutral',{slAtr:o.slAtr,rr:o.rr,minConfirm:o.minConfirm,minScore:Math.min(o.minScore,5)});
    if(!r.ok){i++;continue}
    var e=execTrade(cs,i,r.dir,r.plan,o.target,o.cost);
    if(e.skip){i++;continue}
    if(e.open)break;
    R.push(e.r);i=e.j+1;
  }
  return R;
}
function scalpAnalyse(cs,tf,bias,o,sym,nowMs,near){
  var i=cs.length-1,r=scalpPick(cs,i,tf,bias,o),st=statsOf(scalpBacktest(cs,tf,o)),ses=!o.session||inSession(sym,nowMs);
  var out={ok:r.ok&&ses,dir:r.ok&&ses?r.dir:'WAIT',why:r.ok?(ses?r.why:'Outside the London and New York session, so the scalp bot stays out'):r.why,stats:st,price:cs[i].c};
  if(r.ok){
    out.plan=r.plan;out.name=r.name;out.checks=r.checks;out.lean=r.dir;
    out.conf=confidenceOf(r.q,{w:st.w,n:st.n},r.confirm.n,near);
  }
  return out;
}
if(typeof module!=='undefined'&&module.exports)module.exports={pivots:pivots,trendOf:trendOf,levelsOf:levelsOf,scoreAt:scoreAt,decide:decide,htfTrend:htfTrend,HTF:HTF,STRATS:STRATS,analyseAll:analyseAll,scalpAnalyse:scalpAnalyse,scalpPick:scalpPick,scalpBacktest:scalpBacktest,SCALP_DEF:SCALP_DEF,inSession:inSession,indConfirm:indConfirm,linePivots:linePivots,statsOf:statsOf,backtestOn:backtestOn,backtestStrat:backtestStrat,runStrat:runStrat,atrAt:atrAt,ctxAt:ctxAt,fvgList:fvgList,orderBlocks:orderBlocks,smcState:smcState,confidenceOf:confidenceOf};
