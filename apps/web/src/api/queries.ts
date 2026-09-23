import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type {
  AlarmsResponse,
  DailyUsageResponse,
  Kpi,
  LoadCurveResponse,
  MetersResponse,
  Overview,
} from './types';

const POLL_MS = 10_000;

function rangeQs(start?: string, end?: string): string {
  const p = new URLSearchParams();
  if (start) p.set('start', start);
  if (end) p.set('end', end);
  return p.toString();
}

export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: () => apiGet<Overview>('/overview'), refetchInterval: POLL_MS });
}

export function useKpi(start?: string, end?: string) {
  const qs = rangeQs(start, end);
  return useQuery({
    queryKey: ['kpi', start, end],
    queryFn: () => apiGet<Kpi>(`/kpi${qs ? `?${qs}` : ''}`),
    refetchInterval: POLL_MS,
  });
}

export function useDailyUsage(start?: string, end?: string) {
  const qs = rangeQs(start, end);
  return useQuery({
    queryKey: ['daily-usage', start, end],
    queryFn: () => apiGet<DailyUsageResponse>(`/daily-usage${qs ? `?${qs}` : ''}`),
    refetchInterval: POLL_MS,
  });
}

export function useLoadCurve(params: { start?: string; end?: string; mode: string; meters?: string[]; category?: string }) {
  const qs = new URLSearchParams();
  if (params.start) qs.set('start', params.start);
  if (params.end) qs.set('end', params.end);
  qs.set('mode', params.mode);
  if (params.meters?.length) qs.set('meters', params.meters.join(','));
  if (params.category) qs.set('category', params.category);
  return useQuery({
    queryKey: ['load-curve', qs.toString()],
    queryFn: () => apiGet<LoadCurveResponse>(`/load-curve?${qs.toString()}`),
    refetchInterval: POLL_MS,
  });
}

export function useMeters() {
  return useQuery({ queryKey: ['meters'], queryFn: () => apiGet<MetersResponse>('/meters'), refetchInterval: POLL_MS });
}

export function useAlarms() {
  return useQuery({ queryKey: ['alarms'], queryFn: () => apiGet<AlarmsResponse>('/alarms'), refetchInterval: POLL_MS });
}
