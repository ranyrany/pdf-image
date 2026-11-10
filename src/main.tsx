import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip from 'jszip';
import './style.css';
pdfjs.GlobalWorkerOptions.workerSrc = worker;

export function parsePages(value: string, total: number): number[] {
  const pages = new Set<number>();
  if (!value.trim()) throw new Error('변환할 페이지를 입력해 주세요. 예: 1-3, 5');
  for (const part of value.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('페이지는 1-3, 5처럼 입력해 주세요.');
    const from = Number(match[1]), to = Number(match[2] ?? match[1]);
    if (from < 1 || to > total || from > to) throw new Error(`1~${total} 사이의 올바른 페이지 범위를 입력해 주세요.`);
    for (let i = from; i <= to; i++) pages.add(i);
  }
  return [...pages].sort((a,b) => a-b);
}
type Result = { page: number; url: string; blob: Blob; name: string };
const bytes = (n: number) => n < 1048576 ? `${Math.round(n/1024)} KB` : `${(n/1048576).toFixed(1)} MB`;
function save(url: string, name: string) { const a = document.createElement('a'); a.href=url; a.download=name; a.click(); }
function App() {
  const [doc,setDoc] = useState<pdfjs.PDFDocumentProxy|null>(null);
  const [file,setFile] = useState<File|null>(null);
  const [busy,setBusy] = useState(false), [loading,setLoading] = useState(false);
  const [error,setError] = useState(''), [status,setStatus] = useState('');
  const [mode,setMode] = useState('all'), [range,setRange] = useState('');
  const [format,setFormat] = useState<'png'|'jpg'>('png'), [dpi,setDpi] = useState(150);
  const [results,setResults] = useState<Result[]>([]), [progress,setProgress] = useState(0);
  const [thumbs,setThumbs] = useState<{page:number;url:string}[]>([]), [batch,setBatch] = useState(0);
  const [previewing,setPreviewing] = useState(false);
  const [drag,setDrag] = useState(false), [zipping,setZipping] = useState(false);
  const input = useRef<HTMLInputElement>(null), cancelled = useRef(false);
  const active = useRef<pdfjs.RenderTask|null>(null);
  const loadingTask = useRef<pdfjs.PDFDocumentLoadingTask|null>(null);
  const currentResults = useRef<Result[]>([]);
  const documentRef = useRef<pdfjs.PDFDocumentProxy|null>(null);
  function clearResults() { currentResults.current.forEach(r=>URL.revokeObjectURL(r.url)); currentResults.current=[]; setResults([]); }
  useEffect(()=>()=>{cancelled.current=true;active.current?.cancel();void loadingTask.current?.destroy();currentResults.current.forEach(r=>URL.revokeObjectURL(r.url));},[]);
  useEffect(()=>{
    let stopped=false; const urls:string[]=[]; let task:pdfjs.RenderTask|null=null;
    setThumbs([]);setPreviewing(!!doc);
    if(doc) void (async()=>{
      for(let n=batch*12+1;n<=Math.min(doc.numPages,batch*12+12);n++) {
        let page:pdfjs.PDFPageProxy|undefined; const canvas=document.createElement('canvas');
        try {
          page=await doc.getPage(n); if(stopped) break;
          const base=page.getViewport({scale:1}), viewport=page.getViewport({scale:Math.min(180/base.width,240/base.height)});
          canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          task=page.render({canvas,viewport,background:'#ffffff'});await task.promise;
          const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
          if(blob&&!stopped){const url=URL.createObjectURL(blob);urls.push(url);setThumbs(t=>[...t,{page:n,url}]);}
        } catch(e) {if(!stopped) setError(`미리보기를 불러오지 못했습니다. ${e instanceof Error?e.message:''}`);}
        finally {canvas.width=0;canvas.height=0;if(!busy) page?.cleanup();}
        if(stopped) break;
      }
      if(!stopped)setPreviewing(false);
    })();
    return()=>{stopped=true;task?.cancel();urls.forEach(URL.revokeObjectURL);};
  },[doc,batch]);
  async function open(file:File) {
    if(busy||loading||zipping) return;
    setError('');setStatus('');
    if(!/\.pdf$/i.test(file.name)) {setError('PDF 파일을 선택해 주세요.');return;}
    setLoading(true);clearResults();setDoc(null);setFile(null);setBatch(0);setProgress(0);
    try {
      await documentRef.current?.destroy();documentRef.current=null;
      const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,cMapUrl:import.meta.env.BASE_URL+'pdf-assets/cmaps/',cMapPacked:true,standardFontDataUrl:import.meta.env.BASE_URL+'pdf-assets/standard_fonts/',wasmUrl:import.meta.env.BASE_URL+'pdf-assets/wasm/'});
      loadingTask.current=task;
      const loaded=await task.promise; documentRef.current=loaded;setDoc(loaded);setFile(file);
      setMode('all');setRange('');
    } catch(e) {
      const name=e instanceof Error?e.name:'';
      setError(name==='PasswordException'?'암호가 필요한 PDF입니다. PDF 편집 프로그램에서 암호를 해제한 복사본을 저장한 후 다시 선택해 주세요.':'PDF를 열 수 없습니다. 파일이 손상되었거나 지원하지 않는 형식입니다. 다른 PDF 뷰어에서 열리는지 확인해 주세요.');
      await loadingTask.current?.destroy();
    } finally {setLoading(false);}
  }
  let selected:number[]=[];let rangeError='';
  if(doc) {try {selected=mode==='all'?Array.from({length:doc.numPages},(_,i)=>i+1):parsePages(range,doc.numPages);}catch(e){rangeError=(e as Error).message;}}
  async function convert() {
    if(!doc||!selected.length||busy||previewing) return;
    const pages=[...selected];setBusy(true);cancelled.current=false;clearResults();setProgress(0);setError('');setStatus('변환을 준비하고 있습니다.');
    try {
      for(const n of pages) {
        if(cancelled.current) break;
        const page=await doc.getPage(n), canvas=document.createElement('canvas');
        try {
          if(cancelled.current) break;
          const viewport=page.getViewport({scale:dpi/72});
          const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);
          if(width*height>32000000||width>16384||height>16384) throw new Error(`${n}쪽의 크기가 너무 큽니다. 150 DPI로 낮추거나 원본 페이지 크기를 줄여 주세요.`);
          canvas.width=width;canvas.height=height;setStatus(`${n}쪽 변환 중 · ${dpi} DPI`);
          active.current=page.render({canvas,viewport,background:format==='jpg'?'#ffffff':undefined});
          await active.current.promise;active.current=null;
          if(cancelled.current) break;
          const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('이미지 생성에 실패했습니다. 해상도를 낮춰 주세요.')),format==='jpg'?'image/jpeg':'image/png',0.92));
          if(cancelled.current) break;
          const result={page:n,blob,url:URL.createObjectURL(blob),name:`${file!.name.replace(/\.pdf$/i,'')}-${String(n).padStart(3,'0')}.${format}`};
          currentResults.current=[...currentResults.current,result];setResults(currentResults.current);
          setProgress(Math.round(currentResults.current.length/pages.length*100));
        } finally {active.current=null;canvas.width=0;canvas.height=0;page.cleanup();}
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      setStatus(cancelled.current?`변환을 취소했습니다. 완료된 ${currentResults.current.length}장은 다운로드할 수 있습니다.`:`${currentResults.current.length}장 변환을 완료했습니다.`);
    }catch(e){if(cancelled.current)setStatus(`변환을 취소했습니다. 완료된 ${currentResults.current.length}장은 유지됩니다.`);else setError(e instanceof Error?e.message:'변환 중 오류가 발생했습니다.');}
    finally {setBusy(false);await doc.cleanup();}
  }
  async function zip() {
    setZipping(true);setError('');
    try {const zip=new JSZip();for(const r of currentResults.current)zip.file(r.name,r.blob);
      const blob=await zip.generateAsync({type:'blob',compression:'STORE',streamFiles:true},m=>setStatus(`ZIP 준비 중 · ${Math.round(m.percent)}%`));
      const url=URL.createObjectURL(blob);save(url,`${file?.name.replace(/\.pdf$/i,'') ?? 'images'}-images.zip`);setTimeout(()=>URL.revokeObjectURL(url),60000);setStatus('ZIP 파일을 준비했습니다. 브라우저의 다운로드를 확인해 주세요.');
    }catch{setError('ZIP을 만들지 못했습니다. 메모리가 부족할 수 있습니다. 개별 이미지를 다운로드하거나 페이지를 나누어 변환해 주세요.');}finally{setZipping(false);}
  }
  const locked=busy||loading||zipping;
  return <><header><a className="brand" href="."><span className="brand-icon">▧</span> 한 장<span className="brand-sub">PDF TO IMAGE</span></a><span className="privacy">● 내 기기에서 안전하게</span></header>
    <main><div className="intro"><span className="eyebrow">설치 없이, 업로드 없이</span><h1>PDF를 이미지로,<br className="mobile"/> 가볍게.</h1><p>필요한 페이지만 골라 선명한 이미지로 저장하세요.<br/>모든 작업은 이 브라우저 안에서 이루어집니다.</p></div>
    <div className="workspace"><section className="document-panel"><div className="section-title"><h2><span>01</span> PDF 선택</h2>{file&&<button className="text-button" disabled={locked} onClick={()=>input.current?.click()}>파일 바꾸기</button>}</div>
      <input ref={input} type="file" accept=".pdf,application/pdf" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void open(f);e.target.value='';}}/>
      <button disabled={locked} className={`dropzone ${drag?'drag':''} ${file?'compact':''}`} onClick={()=>input.current?.click()} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);if(e.dataTransfer.files.length!==1){setError('한 번에 PDF 파일 하나를 선택해 주세요.');return;}void open(e.dataTransfer.files[0]);}}>
        <span className="file-icon">{file?'PDF':'↥'}</span><strong>{loading?'PDF를 읽고 있습니다…':file?file.name:'PDF 파일을 여기에 놓아주세요'}</strong><span>{file?`${bytes(file.size)} · 전체 ${doc?.numPages}쪽`:'또는 클릭해서 파일 선택'}</span>{!file&&<small>PDF 파일 1개 · 서버 전송 없음</small>}</button>
      {doc?<><div className="preview-heading"><h3>페이지 미리보기 <span>{doc.numPages}쪽</span></h3><small>클릭하여 페이지 선택</small></div><div className="thumbnails">{thumbs.map(t=><button key={t.page} disabled={locked} className={`thumbnail ${selected.includes(t.page)?'selected':''}`} aria-label={`${t.page}쪽 ${selected.includes(t.page)?'선택 해제':'선택'}`} aria-pressed={selected.includes(t.page)} onClick={()=>{const next=selected.includes(t.page)?selected.filter(n=>n!==t.page):[...selected,t.page].sort((a,b)=>a-b);setMode('custom');setRange(next.join(', '));}}><div><img src={t.url} alt={`${t.page}쪽 미리보기`}/><span className="check">{selected.includes(t.page)?'✓':'+'}</span></div><span>{t.page}쪽</span></button>)}</div>{doc.numPages>12&&<nav className="pager"><button disabled={locked||batch===0} onClick={()=>setBatch(b=>b-1)}>← 이전</button><span>{batch+1} / {Math.ceil(doc.numPages/12)}</span><button disabled={locked||(batch+1)*12>=doc.numPages} onClick={()=>setBatch(b=>b+1)}>다음 →</button></nav>}</>:<div className="empty-preview"><span>▤</span><p>PDF를 선택하면<br/>페이지를 미리 볼 수 있어요.</p></div>}
      </section><aside><div className="section-title"><h2><span>02</span> 변환 설정</h2></div><fieldset disabled={locked||!doc}><legend>변환할 페이지</legend><div className="segments"><button className={mode==='all'?'active':''} onClick={()=>setMode('all')}>전체 페이지</button><button className={mode==='custom'?'active':''} onClick={()=>setMode('custom')}>직접 선택</button></div>{mode==='custom'&&<><label className="sr-only" htmlFor="range">페이지 범위</label><input id="range" value={range} placeholder="예: 1-3, 5, 8" onChange={e=>setRange(e.target.value)} aria-describedby="range-help"/><small id="range-help" className={rangeError?'invalid':''}>{rangeError||`${selected.length}쪽 선택됨 · 미리보기에서도 선택할 수 있어요.`}</small></>}</fieldset>
      <fieldset disabled={locked}><legend>이미지 형식</legend><div className="format-options">{(['png','jpg'] as const).map(f=><button key={f} className={format===f?'active':''} onClick={()=>setFormat(f)}><strong>{f.toUpperCase()}</strong><small>{f==='png'?'선명한 원본 품질':'가벼운 파일 크기'}</small></button>)}</div><small>{format==='jpg'?'JPG는 흰색 배경으로 저장됩니다.':'PNG는 PDF의 투명 배경을 유지합니다.'}</small></fieldset>
      <fieldset disabled={locked}><legend>해상도</legend><div className="segments">{[150,300].map(d=><button key={d} className={dpi===d?'active':''} onClick={()=>setDpi(d)}>{d} DPI <small>{d===150?'기본':'고화질'}</small></button>)}</div><small>{dpi===150?'화면 보기와 공유에 적합해요.':'인쇄에 적합해요. 시간과 메모리가 더 필요해요.'}</small></fieldset>
      <div className="conversion-summary"><span>변환할 페이지</span><strong>{selected.length}쪽</strong></div><button className="primary" disabled={locked||previewing||!doc||!selected.length||!!rangeError} onClick={()=>void convert()}>{busy?'변환하고 있어요…':`이미지로 변환하기 ${doc?'→':''}`}</button>
      {busy&&<button className="cancel" onClick={()=>{cancelled.current=true;active.current?.cancel();}}>변환 취소</button>}
      <p className="local-note">⌁ 파일은 기기 밖으로 전송되지 않습니다.<br/>새로고침하면 파일과 결과가 초기화됩니다.</p></aside></div>
      {error&&<div className="alert" role="alert">{error}</div>}
      {(status||busy)&&<div className="status" role="status" aria-live="polite"><span>{status}</span>{(busy||progress>0)&&<><span>{progress}%</span><progress value={progress} max="100" aria-label="이미지 변환 진행률"/></>}</div>}
      {results.length>0&&<section className="results"><div className="results-heading"><div><span className="eyebrow">READY TO SAVE</span><h2>이미지가 준비됐어요 <span>{results.length}</span></h2></div><button className="primary" disabled={busy||zipping} onClick={()=>void zip()}>{zipping?'ZIP 준비 중…':'모두 ZIP으로 다운로드 ↓'}</button></div><div className="result-grid">{results.map(r=><article key={r.page}><div className="result-image"><img src={r.url} alt={`변환된 ${r.page}쪽`} loading="lazy"/></div><strong>{r.page}쪽</strong><small>{r.name} · {bytes(r.blob.size)}</small><button onClick={()=>save(r.url,r.name)}>이미지 다운로드 ↓</button></article>)}</div><button className="text-button" disabled={locked} onClick={()=>{clearResults();setStatus('결과를 비웠습니다.');setProgress(0);}}>결과 비우기 · 메모리 해제</button></section>}
      <div className="tips"><span>알아두면 좋아요</span><p>큰 PDF는 필요한 페이지만 나눠 변환해 주세요. 변환 중에는 탭을 열어 두세요.<br/>암호가 있는 PDF는 암호를 해제한 복사본이 필요합니다. ZIP 생성에는 추가 메모리가 사용됩니다.</p></div>
    </main><footer><span>한 장</span><p>작은 도구로, 더 간편한 문서 작업.</p><span>100% 브라우저 처리</span></footer></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
