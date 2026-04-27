/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, ChangeEvent, Dispatch, SetStateAction } from 'react';
import { GoogleGenAI } from '@google/genai';

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface MediaItem {
  file: File;
  type: 'image' | 'video';
  previewUrl: string;
}

export default function App() {
  const [originalMedia, setOriginalMedia] = useState<MediaItem | null>(null);
  const [suspectedMedia, setSuspectedMedia] = useState<MediaItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
        } else {
          reject(new Error("Canvas not supported"));
        }
      };
      
      img.onerror = error => {
         URL.revokeObjectURL(objectUrl);
         reject(error);
      };
      
      img.src = objectUrl;
    });
  };

  const extractFrames = async (file: File, maxFrames: number = 4): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.style.display = 'none';
      video.muted = true;
      video.playsInline = true;
      video.src = URL.createObjectURL(file);
      document.body.appendChild(video);
      
      video.onloadedmetadata = async () => {
        try {
          const duration = video.duration || 1;
          const interval = duration / (maxFrames + 1);
          const frames: string[] = [];
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          const ratio = video.videoWidth / video.videoHeight || 16/9;
          canvas.width = Math.min(320, video.videoWidth || 320);
          canvas.height = canvas.width / ratio;

          for (let i = 1; i <= maxFrames; i++) {
            video.currentTime = Math.min(interval * i, duration - 0.1);
            await new Promise((r) => { video.onseeked = r; });
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const base64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
              if (base64) frames.push(base64);
            }
          }
          document.body.removeChild(video);
          resolve(frames);
        } catch(e) {
          if (video.parentNode) document.body.removeChild(video);
          reject(e);
        }
      };
      
      video.onerror = () => {
        if (video.parentNode) document.body.removeChild(video);
        reject(new Error("Failed to load video format"));
      };
      
      video.load();
    });
  };

  const handleMediaUpload = (
    e: ChangeEvent<HTMLInputElement>, 
    setMedia: Dispatch<SetStateAction<MediaItem | null>>
  ) => {
    const file = e.target.files?.[0];
    if (file) {
      setMedia({
        file,
        type: file.type.startsWith('video/') ? 'video' : 'image',
        previewUrl: URL.createObjectURL(file)
      });
    }
  };

  const handleCheck = async () => {
    if (!originalMedia || !suspectedMedia) {
      setError('SYSTEM ERR: BOTH SECTORS REQUIRE SOURCE MEDIA.');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    const prompt = `
You are an AI-powered Digital Asset Monitoring System. 
Your task is to compare visual media (images or extracted video frames) from an "Original" source and a "Suspected" source to detect unauthorized usage, modifications, and AI-generated deepfakes.

Analyze both sources visually.
Detect similarity based on:
- Players / objects / facial features
- Actions
- Scene context
- Background
Look closely for AI artifacts, unnatural lighting, or inconsistencies in the "Suspected" media.

Rules:
- Same clip/image -> Exact Match
- Same clip/image edited (filters, crops, slight alterations) -> Partial Match
- If the "Suspected" media features the SAME PERSON/SUBJECT as the "Original" media, but the scene appears to be an AI-generated fake, deepfake, or synthesized scenario -> AI Generated Fake Match
- Completely different subjects and events (with no AI generation of the original subject) -> No Match

Output Format (STRICTLY THIS):
Match Type: Exact Match / Partial Match / AI Generated Fake Match / No Match
Confidence Score: <number>%
Risk Level: Low / Medium / High
Detection Method: Frame Match / Visual Pattern Match / AI Artifact Detection / No Match
Explanation: <1-2 lines based on visual evidence, explicitly mentioning if AI artifacts are present>
`;

    try {
      let originalData: any[] = [];
      let suspectedData: any[] = [];

      setLoadingStage('EXTRACTING INSTRUCTION VECTORS...');
      
      if (originalMedia.type === 'video') {
         const frames = await extractFrames(originalMedia.file, 2);
         originalData = frames.map(f => ({ inlineData: { data: f, mimeType: 'image/jpeg' } }));
      } else {
         const base64 = await fileToBase64(originalMedia.file);
         originalData = [{ inlineData: { data: base64, mimeType: 'image/jpeg' } }];
      }

      if (suspectedMedia.type === 'video') {
         const frames = await extractFrames(suspectedMedia.file, 2);
         suspectedData = frames.map(f => ({ inlineData: { data: f, mimeType: 'image/jpeg' } }));
      } else {
         const base64 = await fileToBase64(suspectedMedia.file);
         suspectedData = [{ inlineData: { data: base64, mimeType: 'image/jpeg' } }];
      }

      setLoadingStage('ANALYZING VISUAL DATA...');

      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: [
          prompt,
          "--- ORIGINAL MEDIA ---",
          ...originalData,
          "--- SUSPECTED MEDIA ---",
          ...suspectedData
        ],
        config: {
          systemInstruction: 'You are an advanced digital asset protection AI. Strict adherence to output formatting is mandatory. Maintain objective tone.',
        }
      });
      
      let fullText = '';
      for await (const chunk of responseStream) {
        fullText += chunk.text;
        setResult(fullText);
      }
    } catch (err: any) {
      console.error(err);
      setError(`CRITICAL_FAILURE: ${err.message || 'UNKNOWN_ERR_CODE'}`);
    } finally {
      setLoading(false);
      setLoadingStage(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans p-4 md:p-8 font-normal tracking-normal relative">
      <div className="max-w-5xl mx-auto relative z-10 flex flex-col h-full">
        <header className="bg-slate-900 text-slate-50 px-6 py-4 flex items-center justify-between border-b border-slate-700 rounded-t-xl shrink-0 shadow-lg">
          <h1 className="flex items-center gap-3 font-bold text-lg tracking-wide m-0">
            <div className="w-8 h-8 bg-sky-400 rounded-md flex items-center justify-center text-slate-900 text-sm shadow-inner">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
            </div>
            <span>ASSET_PROTECT_SYS</span>
          </h1>
          <p className="bg-slate-800 px-3 py-1 rounded-full text-xs text-slate-400 border border-slate-700 m-0 hidden md:block">
            SYS.VER 3.0 // OMNIVISION PROTOCOL
          </p>
        </header>

        <main className="flex-1 flex flex-col md:flex-row gap-6 p-6 overflow-hidden bg-white rounded-b-xl border border-t-0 border-slate-200 shadow-[0_4px_12px_-2px_rgba(0,0,0,0.05)]">
          <section className="flex flex-col gap-6 md:w-[420px] shrink-0">
             <div className="flex-1">
                 <label className="block text-[13px] font-semibold mb-2 text-slate-700 flex justify-between">
                   <span>INPUT // ORIGINAL_MEDIA</span>
                   <span className="text-slate-400">01</span>
                 </label>
                 <div className="relative w-full min-h-[180px] border-2 border-dashed border-slate-300 rounded-lg overflow-hidden bg-[#fcfcfd] flex flex-col items-center justify-center hover:bg-slate-50 transition-colors group">
                    {originalMedia ? (
                      <>
                        {originalMedia.type === 'video' ? (
                          <video src={originalMedia.previewUrl} className="w-full h-auto max-h-[500px] object-contain" muted controls autoPlay loop playsInline />
                        ) : (
                          <img src={originalMedia.previewUrl} alt="Original" className="w-full h-auto max-h-[500px] object-contain" />
                        )}
                        <div className="absolute inset-0 bg-slate-900/60 hidden group-hover:flex items-center justify-center text-white text-sm font-semibold backdrop-blur-sm transition-all pointer-events-none">
                           Click to Change Media
                        </div>
                      </>
                    ) : (
                      <div className="text-center p-4 cursor-pointer py-12 w-full h-full">
                        <svg className="w-8 h-8 text-slate-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" /></svg>
                        <p className="text-sm font-medium text-slate-600">Click to upload Original Media</p>
                        <p className="text-xs text-slate-400 mt-1">Video (MP4/WEBM) or Image</p>
                      </div>
                    )}
                    <input 
                      type="file" 
                      accept="video/*,image/*" 
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      onChange={(e) => handleMediaUpload(e, setOriginalMedia)}
                    />
                 </div>
             </div>

             <div className="flex-1">
                 <label className="block text-[13px] font-semibold mb-2 text-slate-700 flex justify-between">
                   <span>INPUT // SUSPECTED_MEDIA</span>
                   <span className="text-slate-400">02</span>
                 </label>
                 <div className="relative w-full min-h-[180px] border-2 border-dashed border-slate-300 rounded-lg overflow-hidden bg-[#fcfcfd] flex flex-col items-center justify-center hover:bg-slate-50 transition-colors group">
                    {suspectedMedia ? (
                      <>
                        {suspectedMedia.type === 'video' ? (
                          <video src={suspectedMedia.previewUrl} className="w-full h-auto max-h-[500px] object-contain" muted controls autoPlay loop playsInline />
                        ) : (
                          <img src={suspectedMedia.previewUrl} alt="Suspected" className="w-full h-auto max-h-[500px] object-contain" />
                        )}
                        <div className="absolute inset-0 bg-slate-900/60 hidden group-hover:flex items-center justify-center text-white text-sm font-semibold backdrop-blur-sm transition-all pointer-events-none">
                           Click to Change Media
                        </div>
                      </>
                    ) : (
                      <div className="text-center p-4 cursor-pointer py-12 w-full h-full">
                        <svg className="w-8 h-8 text-slate-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" /></svg>
                        <p className="text-sm font-medium text-slate-600">Click to upload Suspected Media</p>
                        <p className="text-xs text-slate-400 mt-1">Video (MP4/WEBM) or Image</p>
                      </div>
                    )}
                    <input 
                      type="file" 
                      accept="video/*,image/*" 
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      onChange={(e) => handleMediaUpload(e, setSuspectedMedia)}
                    />
                 </div>
             </div>

             <button 
               onClick={handleCheck}
               disabled={loading}
               className="bg-slate-900 text-white p-3.5 rounded-lg border-none font-semibold text-sm w-full transition-colors hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed mt-2 shadow-md"
             >
               {loading ? (
                 <span className="flex items-center justify-center gap-2">
                   <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                   {loadingStage || 'PROCESSING...'}
                 </span>
               ) : (
                 <span>INITIATE_PROTOCOL &gt;</span>
               )}
             </button>
             
             {error && (
               <div className="border border-red-200 bg-red-50 p-4 text-red-600 font-semibold text-sm rounded-lg mt-2">
                 {error}
               </div>
             )}
          </section>

          <section className="bg-slate-50 border border-slate-200 rounded-xl p-6 flex-1 flex flex-col">
            <h2 className="text-[14px] font-semibold uppercase tracking-wider text-slate-500 mb-5 flex items-center gap-2 border-b border-slate-200 pb-3">OUTPUT_TERMINAL</h2>
            
            <div className="flex-1 bg-white border border-slate-200 rounded-xl p-6 font-sans text-sm relative overflow-hidden shadow-sm flex flex-col">
               
               {!result && !loading && (
                 <div className="text-slate-400 flex items-center justify-center h-full flex-col font-medium">
                   <div className="w-12 h-12 border-4 border-slate-100 rounded-full mb-4"></div>
                   AWAITING_MEDIA_INPUT...
                 </div>
               )}
               
               {!result && loading && (
                 <div className="text-slate-500 h-full flex flex-col justify-center items-center font-medium gap-3">
                    <div className="w-8 h-8 border-4 border-slate-200 border-t-sky-400 rounded-full animate-spin mb-2"></div>
                    <p className="animate-pulse">&gt; ESTABLISHING NEURAL LINK...</p>
                    <p className="animate-pulse" style={{ animationDelay: '0.1s' }}>&gt; ALIGNING TEMPORAL VECTORS...</p>
                    <p className="animate-pulse" style={{ animationDelay: '0.2s' }}>&gt; SYNTHESIZING MATCH CONFIDENCE...</p>
                 </div>
               )}

               {result && (
                 <div className="text-slate-800 whitespace-pre-wrap leading-relaxed animate-fade-in flex flex-col h-full">
                   <p className="text-sky-600 font-semibold mb-4 border-b border-slate-100 pb-2 flex items-center gap-2">
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                     {loading ? 'ANALYSING_STREAM...' : 'ANALYSIS_COMPLETE'}
                   </p>
                   <div className="bg-slate-50 p-5 rounded-lg border border-slate-200 shadow-inner flex-1 overflow-auto">
                     {result}
                   </div>
                 </div>
               )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

