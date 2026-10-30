'use client';

import { Workbench } from '@/components/v2/Workbench';
import { RequireDestination } from '@/components/RequirePermission';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { ModuleVisibility } from '@/components/ModuleVisibility';
import { EmployeeModuleVisibility } from '@/components/EmployeeModuleVisibility';

/**
 * Which screens each role and each employee sees (owner request 2026-10-30).
 *
 * Roles carry the defaults; the Employees tab adjusts individuals, singly or
 * in bulk. Display only, on top of permissions: hiding a screen never takes
 * away what a person may do, and a switch never grants a screen their role
 * cannot use.
 */
export default function ConfigurationPage() {
  return (
    <Workbench
      title="Configuration"
      description="Decide which modules each role and each employee sees on the web and on the phone."
    >
      <RequireDestination href="/configuration">
        <Tabs defaultValue="roles">
          <TabsList>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="employees">Employees</TabsTrigger>
          </TabsList>
          <TabsContent value="roles"><ModuleVisibility /></TabsContent>
          <TabsContent value="employees"><EmployeeModuleVisibility /></TabsContent>
        </Tabs>
      </RequireDestination>
    </Workbench>
  );
}
