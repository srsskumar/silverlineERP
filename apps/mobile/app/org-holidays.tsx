/**
 * Holidays: the year's public/festival/regional calendar, read-only.
 *
 * Adding or withdrawing a holiday (apps/web/app/org/holidays/page.tsx) is an
 * organisation-wide policy change gated by holiday.manage; this is the
 * lookup a field employee actually needs — what's a holiday this year,
 * where, before planning leave around it.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../src/auth/AuthContext";
import { getHolidays } from "../src/api/endpoints";
import { holidayScopeLabel } from "../src/holidaysFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { BackHeader, Button, Card, EmptyState, ListRow, Loading, Muted, Row, Screen } from "../src/ui/primitives";
import { space } from "../src/theme";
import { day } from "@silverline/shared";

function OrgHolidaysScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("holiday.read");
  const [year, setYear] = useState(new Date().getFullYear());

  const holidays = useQuery({
    queryKey: ["holidays", year],
    queryFn: () => getHolidays(year),
    enabled: canRead,
  });

  const rows = holidays.data?.items ?? [];

  return (
    <Screen>
      <BackHeader title="Holidays" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>The year's holiday calendar, org-wide and by location.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to holidays"
          message="This screen needs the holiday.read permission."
        />
      ) : (
        <>
          <Row gap={space.sm} style={{ alignItems: "center", marginBottom: space.md }}>
            <Button title="◀" variant="secondary" onPress={() => setYear((y) => y - 1)} />
            <Muted style={{ flex: 1, textAlign: "center", fontWeight: "700" }}>{year}</Muted>
            <Button title="▶" variant="secondary" onPress={() => setYear((y) => y + 1)} />
          </Row>

          <Card>
            {holidays.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState icon="calendar-outline" title={`No holidays in ${year}`} />
            ) : (
              rows.map((h, i, arr) => (
                <ListRow
                  key={h.id}
                  title={h.name}
                  subtitle={`${day(h.date)} · ${h.type} · ${holidayScopeLabel(h)}`}
                  last={i === arr.length - 1}
                />
              ))
            )}
          </Card>
        </>
      )}
    </Screen>
  );
}

export default withScreenBoundary(OrgHolidaysScreen);
