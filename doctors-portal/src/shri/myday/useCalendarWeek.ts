/**
 * The week the calendar is showing (`useShri.calendarAnchor`), day by day, from
 * the same live calendar as My Day — so Blocks and leave and the calendar card
 * move through the weeks together and never disagree about a day.
 */

import { useMemo } from 'react'

import { useShri } from '../state/store'

import { useMyDay, type CalendarDay } from './useMyDay'

export function useCalendarWeek(): CalendarDay[] {
  const { weekDays } = useMyDay()
  const anchor = useShri((s) => s.calendarAnchor)
  return useMemo(() => {
    const [y, m, d] = anchor.split('-').map(Number)
    return weekDays(new Date(y, m - 1, d))
  }, [weekDays, anchor])
}
