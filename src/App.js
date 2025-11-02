import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "framer-motion";
import { saveAs } from "file-saver";
import { createClient } from "@supabase/supabase-js";

// ---------------- CONFIG ----------------
const SUPABASE_URL = "https://ryomgzmpdbdtgcmhwany.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5b21nem1wZGJkdGdjbWh3YW55Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIxMDM3MDksImV4cCI6MjA3NzY3OTcwOX0.96yId-r2FhVTyGahhfonQYxBe60chxkf5Mz-6sOffjQ";
const GOOGLE_API_KEY = "AIzaSyCGbN6tDS7KmsOFafvPgOC8-1JRW85KjGg";

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const regions = ["All", "Europe", "North America", "Asia", "Africa", "Oceania"];
const description = "Find projects, decision-makers, tenders and hiring leads. Store, search and enrich — fast.";

// ---------------- HELPERS ----------------
const buildLinkedInURL = (name, company) =>
  `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent((name || "") + " " + (company || ""))}`;
const buildEmailLink = (email) => (email ? `mailto:${email}` : null);
const buildPhoneLink = (phone) => (phone ? `tel:${phone}` : null);

function normalizeGeminiResponse(parsed) {
  try {
    if (!parsed) return { enrichedCompanies: [], groundingChunks: [] };
    const companies = [];
    const pushIf = (arr, kind) => {
      (arr || []).forEach((item) => {
        companies.push({
          id:
            item.id ||
            `${kind}-${item.name || item.company || item.project || Math.random().toString(36).slice(2, 9)}`,
          name: item.name || item.company || item.project || "Unknown",
          title: item.title || "",
          project: item.project || "",
          location: item.location || "",
          status: item.status || "",
          email: item.email || "",
          phone: item.phone || "",
          linkedin: item.linkedin || "",
          roles: item.roles || "",
          region: item.region || "Global",
          priority: item.priority || 0,
          raw: item,
        });
      });
    };
    if (parsed.projects) pushIf(parsed.projects, "project");
    if (parsed.decisionMakers) pushIf(parsed.decisionMakers, "dm");
    if (parsed.hiring) pushIf(parsed.hiring, "hiring");
    if (companies.length === 0 && Array.isArray(parsed)) parsed.forEach((c, i) => companies.push({ ...c, id: c.id || `c-${i}` }));
    return { enrichedCompanies: companies, groundingChunks: parsed.groundingChunks || [] };
  } catch (e) {
    console.error("normalize error", e);
    return { enrichedCompanies: [], groundingChunks: [] };
  }
}

// ---------------- AI ENRICHMENT ----------------
async function enrichLeadWithGemini(prompt, pastMemory) {
  if (!GOOGLE_API_KEY) throw new Error("Missing GOOGLE_API_KEY");
  const memoryContext = pastMemory ? `Past data: ${JSON.stringify(pastMemory).slice(0, 2000)}` : "";
  const fullPrompt = `
You are LeadScout: find renewable energy projects, hiring, decision-makers, subcontractors and tenders.
${memoryContext}
User query: "${prompt}"

Return valid JSON ONLY:
{
  "projects": [{"name":"","location":"","status":"","start_date":"","owner":"","contractors":"","region":"","priority":0}],
  "decisionMakers": [{"name":"","title":"","company":"","linkedin":"","email":"","phone":"","region":"","priority":0}],
  "hiring": [{"company":"","roles":"","link":"","region":"","priority":0}],
  "subcontractors": [{"name":"","role":"","project":"","region":"","priority":0}],
  "tenders": [{"id":"","portal":"","deadline":"","status":"","region":"","priority":0}],
  "citations":["https://..."]
}
`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ temperature: 0.2, maxOutputTokens: 1200, candidateCount: 1, prompt: { text: fullPrompt } }),
  });
  const data = await res.json();
  let text = data?.candidates?.[0]?.content?.[0]?.text || data?.output?.[0]?.content?.[0]?.text || data?.text || JSON.stringify(data);

  let parsed = {};
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    console.warn("Failed to parse JSON from Gemini response.", e);
    parsed = { groundingChunks: [{ text: text.slice(0, 1500) }] };
  }

  return normalizeGeminiResponse(parsed);
}

// ---------------- UI COMPONENTS ----------------
function Header({ theme, toggleTheme }) {
  return (
    <header className="flex justify-between items-center p-4 bg-white dark:bg-slate-800 rounded-lg shadow mb-4">
      <div>
        <h1 className="text-2xl font-semibold">LeadScout — Enrichment Agent</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      <div className="flex gap-3 items-center">
        <button onClick={toggleTheme} className="px-3 py-1 border rounded hover:shadow-sm">
          {theme === "light" ? "Dark" : "Light"}
        </button>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <div className="bg-gradient-to-r from-sky-400 to-indigo-600 text-white p-6 rounded-2xl shadow-md mb-4">
      <h2 className="text-2xl md:text-3xl font-bold">Smarter sourcing for renewables & heavy industry</h2>
      <p className="mt-2 text-sm md:text-base text-sky-50/90 max-w-2xl">
        Identify projects, tenders, decision-makers and hiring opportunities with a single query. Save history, re-run with context, export results.
      </p>
    </div>
  );
}

function InputForm({ query, setQuery, handleSearch, handleReset, isLoading, selectedRegion, setSelectedRegion }) {
  return (
    <div className="space-y-3 bg-white dark:bg-slate-800 p-4 rounded-2xl shadow mb-4">
      <label className="text-sm font-medium">Search / Enrich</label>
      <textarea
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="e.g. painters and blasters, Denmark"
        className="w-full p-3 border rounded resize-none bg-transparent"
        rows={3}
      />
      <div className="flex items-center gap-2 flex-wrap">
        <select value={selectedRegion} onChange={(e) => setSelectedRegion(e.target.value)} className="border rounded p-2">
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button onClick={handleSearch} disabled={isLoading} className="px-4 py-2 bg-emerald-500 text-white rounded disabled:opacity-60">
          {isLoading ? "Working..." : "Enrich"}
        </button>
        <button onClick={handleReset} className="px-4 py-2 border rounded">
          Reset
        </button>
        <button
          onClick={() => {
            const blob = new Blob([JSON.stringify({ query, ts: new Date().toISOString() }, null, 2)], { type: "application/json" });
            saveAs(blob, `leadscout-query-${Date.now()}.json`);
          }}
          className="ml-auto px-3 py-2 border rounded text-sm"
        >
          Export Query
        </button>
      </div>
      <div className="text-xs text-slate-400">Tip: include region or company name to get more focused results.</div>
    </div>
  );
}

function HistorySidebar({ history, onLoadHistory, onClearHistory, activeHistoryId }) {
  return (
    <div className="bg-white dark:bg-slate-800 p-3 rounded-2xl shadow space-y-3 mb-4">
      <div className="flex justify-between items-center">
        <h4 className="font-semibold">History</h4>
        <button onClick={onClearHistory} className="text-sm text-rose-500">
          Clear
        </button>
      </div>
      <div className="max-h-[420px] overflow-auto scrollbar-thin space-y-2">
        {history.length === 0 && <div className="text-sm text-slate-400">No history yet — run a search to save results.</div>}
        {history.map((h) => (
          <div
            key={h.id}
            className={`p-2 border rounded hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer ${
              activeHistoryId === h.id ? "bg-sky-50 dark:bg-sky-900/20 border-sky-200" : ""
            }`}
            onClick={() => onLoadHistory(h.id)}
          >
            <div className="text-xs text-slate-600 dark:text-slate-300 font-medium">{h.prompt}</div>
            <div className="text-xs text-slate-400 mt-1">{new Date(h.timestamp).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardPlaceholder() {
  return (
    <div className="bg-white dark:bg-slate-800 p-8 rounded-2xl shadow text-center min-h-[240px]">
      <div className="text-slate-500">Your intelligence report will appear here. Try queries like:</div>
      <div className="mt-4 space-x-2 flex flex-wrap justify-center gap-2">
        <button className="px-3 py-1 border rounded text-sm">"Painters and Blasters, Denmark"</button>
        <button className="px-3 py-1 border rounded text-sm">"Industrial painters, epoxy"</button>
        <button className="px-3 py-1 border rounded text-sm">"Pipe fabrication projects Europe"</button>
      </div>
    </div>
  );
}

// ---------------- MAIN APP ----------------
function App() {
  const [query, setQuery] = useState("");
  const [selectedRegion, setSelectedRegion] = useState("All");
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [activeHistoryId, setActiveHistoryId] = useState(null);
  const [theme, setTheme] = useState("light");

  const toggleTheme = () => setTheme(theme === "light" ? "dark" : "light");

  const handleSearch = async () => {
    if (!query) return;
    setIsLoading(true);
    try {
      const pastMemory = history.map((h) => h.result);
      const result = await enrichLeadWithGemini(query, pastMemory);
      const entry = { id: Date.now(), prompt: query, result, timestamp: new Date().toISOString() };
      setHistory([entry, ...history]);
      setActiveHistoryId(entry.id);
    } catch (e) {
      console.error("Search failed:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setQuery("");
    setSelectedRegion("All");
  };

  const handleLoadHistory = (id) => setActiveHistoryId(id);
  const handleClearHistory = () => {
    setHistory([]);
    setActiveHistoryId(null);
  };

  return (
    <div className={`${theme === "dark" ? "dark bg-slate-900 text-white" : "bg-gray-100 text-black"} min-h-screen p-6`}>
      <Header theme={theme} toggleTheme={toggleTheme} />
      <Hero />
      <InputForm
        query={query}
        setQuery={setQuery}
        handleSearch={handleSearch}
        handleReset={handleReset}
        isLoading={isLoading}
        selectedRegion={selectedRegion}
        setSelectedRegion={setSelectedRegion}
      />
      <div className="grid md:grid-cols-4 gap-4">
        <div className="md:col-span-1">
          <HistorySidebar
            history={history}
            onLoadHistory={handleLoadHistory}
            onClearHistory={handleClearHistory}
            activeHistoryId={activeHistoryId}
          />
        </div>
        <div className="md:col-span-3">
          <DashboardPlaceholder />
        </div>
      </div>
    </div>
  );
}

// ---------------- RENDER ----------------
const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);
