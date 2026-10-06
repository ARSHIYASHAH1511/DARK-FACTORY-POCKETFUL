import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

// Polls a GET endpoint; `refresh` forces an immediate reload after a mutation.
export function usePoll<T>(path: string | null, intervalMs = 1000): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    const res = await api.get<T>(p);
    if (pathRef.current !== p) return; // stage switched mid-flight
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setError(`${res.error.code}: ${res.error.message}`);
    }
  }, []);

  useEffect(() => {
    setData(null);
    if (!path) return;
    load();
    if (intervalMs <= 0) return;
    const id = setInterval(load, intervalMs);
    return () => clearInterval(id);
  }, [path, intervalMs, load]);

  return { data, error, refresh: load };
}
