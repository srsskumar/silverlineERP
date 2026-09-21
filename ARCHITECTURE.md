# Silverline ERP — System Architecture

> **Read this first: this document is the original target design, not a description of the code.**
> What was built differs in ways that matter:
>
> | This document says | The code is |
> | --- | --- |
> | NestJS API | Fastify 5 with raw `pg`, no ORM (`apps/api`, routes registered in `src/createApp.ts`) |
> | Kotlin / Jetpack Compose Android app | Expo SDK 57 React Native app (`apps/mobile`) |
> | Kubernetes, load balancer, TLS 1.3, horizontal scaling | One VM with nginx on plain HTTP, API as a systemd unit, database on Supabase (`docs/OPERATIONS.md`) |
> | Server-rendered Next.js | A static export (`NEXT_VERIFY_BUILD=1`); records open through `/record?type=&id=` |
>
> For how the system actually runs, use `README.md` and `docs/OPERATIONS.md`. The domain model and business rules below remain the intent.

## 1. Architecture Overview

**Pattern:** Modular Monolith with clear domain boundaries
**Deployment:** Cloud-native, horizontally scalable stateless app servers + PostgreSQL
**Platforms:** Web (React/Next.js) + Android (Kotlin/Jetpack Compose)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                   │
├─────────────────────────┬───────────────────────────────────────────────────┤
│      Web App            │              Android App                          │
│   (React/Next.js)       │     (Kotlin/Jetpack Compose)                      │
│   • Admin/PM/TL views   │     • Field employee primary                     │
│   • Dashboard           │     • Offline-first with local DB                │
│   • Board/List/Calendar │     • Biometric auth                             │
│   • Timeline/Gantt      │     • Camera watermark evidence                  │
└───────────┬─────────────┴───────────────────────┬───────────────────────────┘
            │                                     │
            │         HTTPS/WSS                   │
            ▼                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           API GATEWAY / LOAD BALANCER                       │
│                    (Nginx / AWS ALB / Cloudflare)                           │
│   • TLS 1.3 termination                                                   │
│   • Rate limiting                                                          │
│   • Request ID injection                                                   │
│   • CORS configuration                                                     │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                                   │
│                      (Node.js / NestJS / TypeScript)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │   Auth       │  │  Employee   │  │ Attendance  │  │  Projects   │       │
│  │   Module     │  │  Module     │  │  Module     │  │  Module     │       │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘       │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │  Payroll    │  │  Inventory  │  │  Geo-Fence  │  │ Automation  │       │
│  │  Module     │  │  Module     │  │  Module     │  │  Engine     │       │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘       │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │  Analytics  │  │  Reporting  │  │  Notific.   │  │  Webhooks   │       │
│  │  Module     │  │  Module     │  │  Module     │  │  Module     │       │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    SHARED SERVICES                                   │   │
│  │  • Authorization (RBAC middleware)  • Audit Logger                  │   │
│  │  • Validation Pipeline             • Event Bus (in-process)         │   │
│  │  • Idempotency Handler             • File Upload Service            │   │
│  │  • Search Index Service            • Cache Service                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                        │
├───────────────┬─────────────────┬─────────────────┬─────────────────────────┤
│  PostgreSQL   │  Redis          │  Object Storage │  Full-Text Search       │
│  (Primary DB) │  (Cache/Sessions│  (S3/MinIO)     │  (pg_trgm + tsvector)  │
│               │   /Queue)       │                 │                         │
│  • Core data  │  • Session store│  • Documents    │  • Task search          │
│  • Audit log  │  • Rate limiting│  • Evidence     │  • Employee directory   │
│  • Migrations │  • Job queue    │  • Assets       │  • Project search       │
│  • Audit trail│  • Real-time    │  • PDFs         │                         │
│               │    (optional)   │                 │                         │
└───────────────┴─────────────────┴─────────────────┴─────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES LAYER                                │
├───────────────┬─────────────────┬─────────────────┬─────────────────────────┤
│  SMS/WhatsApp │  Payment Gateway│  Weather API    │  Maps/GIS               │
│  (OTP/Notif.) │  (Optional)     │  (Rain holiday) │  (Google Maps)          │
├───────────────┼─────────────────┼─────────────────┼─────────────────────────┤
│  Accounting   │  Email (SMTP/   │  MDM Provider   │  Push Notifications     │
│  Export       │  SendGrid/SES)  │  (Optional)     │  (FCM)                  │
└───────────────┴─────────────────┴─────────────────┴─────────────────────────┘
```

---

## 2. Technology Stack

### 2.1 Backend

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Runtime** | Node.js 20+ LTS | Type-safe TypeScript, mature ecosystem |
| **Framework** | NestJS | Modular architecture, built-in DI, RBAC, validation |
| **Language** | TypeScript 5.x | End-to-end type safety, shared types with frontend |
| **ORM** | Prisma or TypeORM | Migration support, type-safe queries |
| **Validation** | class-validator + Zod | Request/response validation, DTOs |
| **Auth** | Passport.js + JWT | MFA, session management, refresh tokens |

### 2.2 Frontend — Web

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Framework** | Next.js 14+ (App Router) | SSR/SSG, API routes, file-based routing |
| **UI Library** | shadcn/ui + Tailwind CSS | Accessible, composable components |
| **State Management** | TanStack Query | Server state caching, optimistic updates |
| **Board/DnD** | @dnd-kit | Drag-and-drop board interactions |
| **Charts** | Recharts or Tremor | Dashboard analytics, velocity/burndown |
| **Forms** | React Hook Form + Zod | Performant forms with validation |

### 2.3 Android

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Language** | Kotlin | Official Android language |
| **UI** | Jetpack Compose | Modern declarative UI |
| **Local DB** | Room (SQLite) | Offline-first persistence |
| **Sync** | WorkManager + custom sync | Background sync with retry |
| **Auth** | BiometricPrompt + EncryptedSharedPreferences | Biometric + secure storage |
| **Networking** | Retrofit + OkHttp | HTTP client with interceptors |
| **DI** | Hilt | Dependency injection |

### 2.4 Infrastructure

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Database** | PostgreSQL 16 | JSONB, full-text search, CTEs, row-level security |
| **Cache** | Redis 7 | Sessions, rate limiting, job queue (BullMQ) |
| **Object Storage** | AWS S3 / MinIO | Documents, evidence, PDFs |
| **Search** | PostgreSQL tsvector + pg_trgm | Lightweight full-text (avoid Elasticsearch for v1) |
| **Queue** | BullMQ (Redis) | Background jobs, notifications, imports |
| **Container** | Docker + Docker Compose | Local dev, consistent environments |
| **Orchestration** | Kubernetes (production) | Horizontal scaling, rolling deploys |
| **CI/CD** | GitHub Actions | Automated builds, tests, deploys |

---

## 3. Module Architecture

### 3.1 Module Dependency Graph

```
                    ┌──────────────┐
                    │   Auth/AuthZ  │
                    │   Module      │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │  Employee   │  │  Organization│  │  Audit      │
   │  Module     │  │  Module      │  │  Module     │
   └──────┬──────┘  └──────┬──────┘  └─────────────┘
          │                │
          ├────────────────┼────────────────────┐
          │                │                    │
          ▼                ▼                    ▼
   ┌─────────────┐  ┌─────────────┐    ┌─────────────┐
   │ Attendance  │  │  Leave      │    │  Geo-Fence  │
   │ Module      │  │  Module     │    │  Module     │
   └──────┬──────┘  └──────┬──────┘    └─────────────┘
          │                │
          ▼                ▼
   ┌─────────────────────────────────┐
   │         Payroll Module          │
   └─────────────────────────────────┘

   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │  Projects   │  │  Tasks      │  │  Boards     │
   │  Module     │◄─┤  Module     │◄─┤  Module     │
   └──────┬──────┘  └──────┬──────┘  └─────────────┘
          │                │
          ├────────────────┤
          │                │
          ▼                ▼
   ┌─────────────┐  ┌─────────────┐
   │  Cycles     │  │  SLA        │
   │  Module     │  │  Engine     │
   └─────────────┘  └─────────────┘

   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │  Inventory  │  │  Assets     │  │  Vendors    │
   │  Module     │◄─┤  Module     │◄─┤  Module     │
   └─────────────┘  └─────────────┘  └─────────────┘

   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │ Automation  │  │  Analytics  │  │  Notific.   │
   │ Engine      │  │  Module     │  │  Module     │
   └─────────────┘  └─────────────┘  └─────────────┘
```

### 3.2 Module Responsibilities

| Module | Domain | Key Entities | Key Operations |
|--------|--------|--------------|----------------|
| **Auth** | Authentication & Authorization | User, Role, Permission, UserRole, Session | Login, MFA, token refresh, RBAC enforcement |
| **Employee** | Workforce Management | Employee, EmployeeDocument, EmployeeImport | CRUD, exit, reactivation, bulk import, sensitive field masking |
| **Organization** | Hierarchy & Config | Organization, District, Mandal, Village, Site | Location hierarchy, org configuration |
| **Attendance** | Time Tracking | AttendanceRecord, AttendanceException, AttendanceEvent | Check-in/out, regularization, duplicate suppression |
| **Leave** | Time Off | LeaveRequest, LeaveBalance, LeaveType | Request, approve/reject, balance ledger |
| **Payroll** | Compensation | PayrollRun, Payslip, PayrollConfig | Period lifecycle, calculation, locking, PDF generation |
| **Geo-Fence** | Location Verification | GeoFence, GeofenceVersion, CheckInDecision | Boundary evaluation, mock-location detection, evidence |
| **Projects** | Project Management | Workspace, Project, ProjectWorkflow, ProjectType | Project lifecycle, workflow configuration |
| **Tasks** | Work Items | Task, TaskDependency, TaskEvidence, Comment, Mention | CRUD, status transitions, dependencies, quick-add |
| **Boards** | View Management | Board, BoardColumn, SavedFilter | List/Kanban/Calendar/Timeline views, saved filters |
| **Cycles** | Iteration Planning | Cycle, CycleMetrics | Sprint creation, rollover, velocity tracking |
| **SLA** | Service Level | SLATracking, SLAEscalation | Breach detection, escalation chains |
| **Inventory** | Stock Management | StockItem, StockTransaction, Invoice | Inward/outward, ledger-driven quantity, low-stock alerts |
| **Assets** | Fixed Assets | Asset, AssetAssignment, AssetAudit | Lifecycle tracking, assignment, QR audit |
| **Vendors** | Procurement | Vendor, PurchaseOrder | Vendor management, purchase history |
| **Automation** | Workflow Automation | AutomationRule, AutomationExecution | Trigger→condition→action rules, execution audit |
| **Analytics** | Reporting & AI | Dashboard, Report, Prediction, Anomaly | KPIs, velocity, burndown, AI predictions |
| **Notifications** | Communication | Notification, NotificationPreference, Mention | Push/SMS/email/in-app, deduplication |
| **Webhooks** | Integrations | WebhookSubscription, WebhookDelivery | Outbound event subscriptions, HMAC signing |
| **Audit** | Compliance | AuditEvent | Append-only event log, compliance reporting |

---

## 4. Database Schema Design

### 4.1 Core Tables

```sql
-- Organization & Hierarchy
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
    locale VARCHAR(10) NOT NULL DEFAULT 'en',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE districts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE mandals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    district_id UUID NOT NULL REFERENCES districts(id),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE villages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mandal_id UUID NOT NULL REFERENCES mandals(id),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

-- Users & Authentication
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    username VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    employee_id UUID REFERENCES employees(id),
    auth_status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    mfa_enabled BOOLEAN NOT NULL DEFAULT false,
    mfa_secret VARCHAR(255),
    last_login_at TIMESTAMPTZ,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uk_users_username UNIQUE (org_id, username),
    CONSTRAINT uk_users_phone UNIQUE (org_id, phone)
);

-- RBAC
CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id),
    name VARCHAR(100) NOT NULL,
    is_system_role BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    CONSTRAINT uk_roles_name UNIQUE (org_id, name)
);

CREATE TABLE permissions (
    code VARCHAR(100) PRIMARY KEY,
    description TEXT NOT NULL,
    module VARCHAR(50) NOT NULL
);

CREATE TABLE role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_code VARCHAR(100) NOT NULL REFERENCES permissions(code),
    scope_type VARCHAR(50),
    scope_id UUID,
    PRIMARY KEY (role_id, permission_code, scope_type, scope_id)
);

CREATE TABLE user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    scope_type VARCHAR(50),
    scope_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    PRIMARY KEY (user_id, role_id, scope_type, scope_id)
);

-- Employee
CREATE TABLE employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    emp_no VARCHAR(50) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    father_name VARCHAR(200),
    date_of_birth DATE,
    gender VARCHAR(20),
    phone VARCHAR(20) NOT NULL,
    phone_secondary VARCHAR(20),
    email VARCHAR(255),
    aadhaar_encrypted TEXT,
    pan_encrypted TEXT,
    address TEXT,
    village_id UUID REFERENCES villages(id),
    district_id UUID REFERENCES districts(id),
    mandal_id UUID REFERENCES mandals(id),
    designation VARCHAR(100),
    department VARCHAR(100),
    date_of_joining DATE NOT NULL,
    date_of_exit DATE,
    exit_reason TEXT,
    exit_approved_by UUID REFERENCES users(id),
    reports_to UUID REFERENCES employees(id),
    salary_basic DECIMAL(12, 2),
    bank_name VARCHAR(100),
    bank_account_encrypted TEXT,
    bank_ifsc VARCHAR(20),
    phonepe_number VARCHAR(20),
    education TEXT,
    skills JSONB DEFAULT '[]',
    experience_years DECIMAL(4, 1),
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    status_changed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uk_emp_no UNIQUE (org_id, emp_no),
    CONSTRAINT uk_emp_phone UNIQUE (org_id, phone)
);

CREATE INDEX idx_employees_reports_to ON employees(reports_to);
CREATE INDEX idx_employees_status ON employees(org_id, status);
CREATE INDEX idx_employees_village ON employees(village_id);

-- Attendance
CREATE TABLE attendance_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    event_type VARCHAR(50) NOT NULL,
    client_timestamp TIMESTAMPTZ NOT NULL,
    server_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    gps_accuracy DECIMAL(8, 2),
    geofence_result VARCHAR(50),
    geofence_id UUID REFERENCES geo_fences(id),
    device_id VARCHAR(255),
    app_version VARCHAR(50),
    source VARCHAR(50) NOT NULL DEFAULT 'ANDROID',
    evidence_id UUID,
    idempotency_key VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_attendance_idempotency UNIQUE (employee_id, event_type, client_timestamp, idempotency_key)
);

CREATE TABLE attendance_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    work_date DATE NOT NULL,
    check_in_event_id UUID REFERENCES attendance_events(id),
    check_out_event_id UUID REFERENCES attendance_events(id),
    total_hours DECIMAL(5, 2),
    overtime_hours DECIMAL(5, 2),
    late_minutes INTEGER,
    early_leave_minutes INTEGER,
    status VARCHAR(50) NOT NULL DEFAULT 'PARTIAL',
    geofence_violation BOOLEAN DEFAULT false,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_attendance_record UNIQUE (employee_id, work_date)
);

CREATE TABLE attendance_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    attendance_record_id UUID REFERENCES attendance_records(id),
    exception_type VARCHAR(50) NOT NULL,
    reason TEXT NOT NULL,
    photo_object_key VARCHAR(500),
    submitted_by UUID NOT NULL REFERENCES users(id),
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Geo-Fence
CREATE TABLE geo_fences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(255) NOT NULL,
    scope_type VARCHAR(50) NOT NULL,
    scope_id UUID NOT NULL,
    geometry_type VARCHAR(20) NOT NULL,
    geometry JSONB NOT NULL,
    tolerance_meters DECIMAL(8, 2) DEFAULT 50,
    accuracy_threshold_meters DECIMAL(8, 2) DEFAULT 100,
    active BOOLEAN NOT NULL DEFAULT true,
    version INTEGER NOT NULL DEFAULT 1,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

-- Leave
CREATE TABLE leave_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_paid BOOLEAN NOT NULL DEFAULT true,
    annual_entitlement DECIMAL(5, 1),
    carry_forward BOOLEAN DEFAULT false,
    max_carry_forward DECIMAL(5, 1),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_leave_type_code UNIQUE (org_id, code)
);

CREATE TABLE leave_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    leave_type_id UUID NOT NULL REFERENCES leave_types(id),
    period_year INTEGER NOT NULL,
    opening_balance DECIMAL(5, 1) NOT NULL DEFAULT 0,
    credits DECIMAL(5, 1) NOT NULL DEFAULT 0,
    consumed DECIMAL(5, 1) NOT NULL DEFAULT 0,
    adjustments DECIMAL(5, 1) NOT NULL DEFAULT 0,
    current_balance DECIMAL(5, 1) GENERATED ALWAYS AS (opening_balance + credits - consumed + adjustments) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_leave_balance UNIQUE (employee_id, leave_type_id, period_year)
);

CREATE TABLE leave_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id),
    leave_type_id UUID NOT NULL REFERENCES leave_types(id),
    from_date DATE NOT NULL,
    to_date DATE NOT NULL,
    total_days DECIMAL(5, 1) NOT NULL,
    reason TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    current_approver_id UUID REFERENCES users(id),
    approval_chain JSONB NOT NULL DEFAULT '[]',
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leave_requests_employee ON leave_requests(employee_id, from_date, to_date);
CREATE INDEX idx_leave_requests_status ON leave_requests(status, current_approver_id);

-- Projects & Tasks
CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE project_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id),
    name VARCHAR(100) NOT NULL,
    is_system_type BOOLEAN NOT NULL DEFAULT false,
    default_workflow_id UUID REFERENCES project_workflows(id),
    custom_field_definitions JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE project_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_type_id UUID NOT NULL REFERENCES project_types(id),
    name VARCHAR(100) NOT NULL,
    statuses JSONB NOT NULL DEFAULT '[]',
    allowed_transitions JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    project_type_id UUID NOT NULL REFERENCES project_types(id),
    workflow_id UUID NOT NULL REFERENCES project_workflows(id),
    description TEXT,
    project_manager_id UUID NOT NULL REFERENCES users(id),
    planned_start_date DATE,
    planned_end_date DATE,
    actual_start_date DATE,
    actual_end_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    priority VARCHAR(50) NOT NULL DEFAULT 'MEDIUM',
    sla_policy_id UUID,
    cycles_enabled BOOLEAN NOT NULL DEFAULT false,
    default_cycle_length_weeks INTEGER DEFAULT 2,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uk_project_code UNIQUE (org_id, code)
);

CREATE INDEX idx_projects_workspace ON projects(workspace_id);
CREATE INDEX idx_projects_status ON projects(org_id, status);
CREATE INDEX idx_projects_pm ON projects(project_manager_id);

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    parent_task_id UUID REFERENCES tasks(id),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    assignee_id UUID REFERENCES users(id),
    reporter_id UUID NOT NULL REFERENCES users(id),
    village_id UUID REFERENCES villages(id),
    site_id UUID,
    status VARCHAR(50) NOT NULL DEFAULT 'TO_DO',
    priority VARCHAR(50) NOT NULL DEFAULT 'MEDIUM',
    planned_start_date DATE,
    planned_end_date DATE,
    actual_start_date DATE,
    actual_end_date DATE,
    estimated_hours DECIMAL(8, 2),
    actual_hours DECIMAL(8, 2),
    cycle_id UUID REFERENCES cycles(id),
    board_position INTEGER NOT NULL DEFAULT 0,
    sla_status VARCHAR(50) DEFAULT 'ON_SCHEDULE',
    sla_warning_at TIMESTAMPTZ,
    sla_breached_at TIMESTAMPTZ,
    custom_fields JSONB DEFAULT '{}',
    labels JSONB DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_tasks_project ON tasks(project_id, status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_cycle ON tasks(cycle_id);
CREATE INDEX idx_tasks_board ON tasks(project_id, status, board_position);

CREATE TABLE task_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    predecessor_id UUID NOT NULL REFERENCES tasks(id),
    successor_id UUID NOT NULL REFERENCES tasks(id),
    dependency_type VARCHAR(50) NOT NULL DEFAULT 'FINISH_TO_START',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    CONSTRAINT uk_task_dependency UNIQUE (predecessor_id, successor_id),
    CONSTRAINT chk_no_self_dependency CHECK (predecessor_id != successor_id)
);

CREATE TABLE task_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    evidence_type VARCHAR(50) NOT NULL,
    object_key VARCHAR(500) NOT NULL,
    file_name VARCHAR(255),
    file_size INTEGER,
    checksum VARCHAR(255),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    watermark_metadata JSONB DEFAULT '{}',
    uploaded_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id),
    author_id UUID NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    edited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_comments_task ON comments(task_id, created_at);

CREATE TABLE mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id UUID NOT NULL REFERENCES comments(id),
    mentioned_user_id UUID NOT NULL REFERENCES users(id),
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mentions_user ON mentions(mentioned_user_id, read_at);

-- Boards & Views
CREATE TABLE boards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    name VARCHAR(255) NOT NULL,
    view_type VARCHAR(50) NOT NULL DEFAULT 'LIST',
    is_default BOOLEAN NOT NULL DEFAULT false,
    column_config JSONB DEFAULT '{}',
    filter_config JSONB DEFAULT '{}',
    owner_id UUID REFERENCES users(id),
    shared BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE board_columns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    status_code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    wip_limit INTEGER,
    color VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_board_columns_board ON board_columns(board_id, position);

CREATE TABLE saved_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id),
    project_id UUID REFERENCES projects(id),
    org_id UUID REFERENCES organizations(id),
    name VARCHAR(100) NOT NULL,
    query_definition JSONB NOT NULL,
    shared BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cycles/Sprints
CREATE TABLE cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    name VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PLANNED',
    goal TEXT,
    velocity INTEGER,
    completed_points INTEGER DEFAULT 0,
    total_points INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_cycles_project ON cycles(project_id, start_date);

-- Labels
CREATE TABLE labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id),
    project_id UUID REFERENCES projects(id),
    name VARCHAR(100) NOT NULL,
    color VARCHAR(20) NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    CONSTRAINT uk_label_name UNIQUE (org_id, project_id, name)
);

CREATE TABLE task_labels (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
);

-- Inventory & Assets
CREATE TABLE stock_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    item_code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    unit VARCHAR(50) NOT NULL,
    reorder_level INTEGER DEFAULT 0,
    available_quantity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uk_stock_item_code UNIQUE (org_id, item_code)
);

CREATE TABLE stock_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_item_id UUID NOT NULL REFERENCES stock_items(id),
    project_id UUID REFERENCES projects(id),
    direction VARCHAR(20) NOT NULL,
    quantity INTEGER NOT NULL,
    reference_type VARCHAR(50),
    reference_id UUID,
    actor_id UUID NOT NULL REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_transactions_item ON stock_transactions(stock_item_id, created_at);
CREATE INDEX idx_stock_transactions_project ON stock_transactions(project_id, created_at);

CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    asset_code VARCHAR(50) NOT NULL,
    serial_number VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    vendor_id UUID REFERENCES vendors(id),
    purchase_date DATE,
    purchase_cost DECIMAL(12, 2),
    current_condition VARCHAR(50) DEFAULT 'GOOD',
    lifecycle_status VARCHAR(50) NOT NULL DEFAULT 'AVAILABLE',
    last_audit_date DATE,
    last_audit_result VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uk_asset_code UNIQUE (org_id, asset_code)
);

CREATE TABLE asset_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES assets(id),
    employee_id UUID REFERENCES employees(id),
    project_id UUID REFERENCES projects(id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by UUID NOT NULL REFERENCES users(id),
    returned_at TIMESTAMPTZ,
    returned_to UUID REFERENCES users(id),
    condition_at_return VARCHAR(50),
    return_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_asset_assignments_asset ON assets(asset_id, returned_at);
CREATE INDEX idx_asset_assignments_employee ON asset_assignments(employee_id, returned_at);

-- Payroll
CREATE TABLE payroll_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    total_gross DECIMAL(14, 2) NOT NULL DEFAULT 0,
    total_deductions DECIMAL(14, 2) NOT NULL DEFAULT 0,
    total_net DECIMAL(14, 2) NOT NULL DEFAULT 0,
    employee_count INTEGER NOT NULL DEFAULT 0,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    locked_by UUID REFERENCES users(id),
    locked_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE payslips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_run_id UUID NOT NULL REFERENCES payroll_runs(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    earnings JSONB NOT NULL DEFAULT '{}',
    deductions JSONB NOT NULL DEFAULT '{}',
    gross DECIMAL(12, 2) NOT NULL,
    total_deductions DECIMAL(12, 2) NOT NULL,
    net_pay DECIMAL(12, 2) NOT NULL,
    lop_days DECIMAL(4, 1) DEFAULT 0,
    pdf_object_key VARCHAR(500),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_payslip UNIQUE (payroll_run_id, employee_id)
);

-- Automation
CREATE TABLE automation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id),
    project_id UUID REFERENCES projects(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    trigger_event VARCHAR(100) NOT NULL,
    trigger_config JSONB DEFAULT '{}',
    conditions JSONB NOT NULL DEFAULT '[]',
    actions JSONB NOT NULL DEFAULT '[]',
    active BOOLEAN NOT NULL DEFAULT true,
    last_run_at TIMESTAMPTZ,
    last_run_result VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE automation_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES automation_rules(id),
    trigger_event VARCHAR(100) NOT NULL,
    trigger_entity_type VARCHAR(100),
    trigger_entity_id UUID,
    matched_conditions JSONB NOT NULL,
    actions_taken JSONB NOT NULL,
    status VARCHAR(50) NOT NULL,
    error_message TEXT,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_by_automation BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_automation_executions_rule ON automation_executions(rule_id, executed_at);

-- Notifications
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES users(id),
    type VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT,
    channel VARCHAR(50) NOT NULL,
    entity_type VARCHAR(100),
    entity_id UUID,
    read_at TIMESTAMPTZ,
    delivered BOOLEAN NOT NULL DEFAULT false,
    delivery_status VARCHAR(50) DEFAULT 'PENDING',
    delivery_error TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, read_at, created_at);

-- Webhooks
CREATE TABLE webhook_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    url VARCHAR(500) NOT NULL,
    secret VARCHAR(255) NOT NULL,
    events JSONB NOT NULL DEFAULT '[]',
    active BOOLEAN NOT NULL DEFAULT true,
    retry_policy JSONB DEFAULT '{"max_retries": 3, "backoff_ms": 1000}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    last_response_status INTEGER,
    last_error TEXT,
    delivered BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit
CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    actor_id UUID REFERENCES users(id),
    actor_ip INET,
    actor_user_agent TEXT,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID,
    before_state JSONB,
    after_state JSONB,
    reason TEXT,
    request_id VARCHAR(100),
    idempotency_key VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_events_org ON audit_events(org_id, created_at);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_actor ON audit_events(actor_id, created_at);
CREATE INDEX idx_audit_events_action ON audit_events(action, created_at);

-- Activity Feed
CREATE TABLE activity_feed_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_feed_entity ON activity_feed_events(entity_type, entity_id, created_at);

-- Holidays
CREATE TABLE holidays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    date DATE NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    scope_type VARCHAR(50),
    scope_id UUID,
    source VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    CONSTRAINT uk_holiday_scope_date UNIQUE (org_id, date, scope_type, scope_id)
);

-- Custom Fields
CREATE TABLE custom_field_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_type_id UUID REFERENCES project_types(id),
    project_id UUID REFERENCES projects(id),
    field_key VARCHAR(100) NOT NULL,
    field_label VARCHAR(255) NOT NULL,
    field_type VARCHAR(50) NOT NULL,
    options JSONB,
    required BOOLEAN NOT NULL DEFAULT false,
    default_value JSONB,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES users(id)
);
```

---

## 5. API Design

### 5.1 API Conventions

- **Base URL:** `/api/v1/`
- **Authentication:** Bearer JWT (short-lived access + refresh token)
- **Idempotency:** `Idempotency-Key` header for mutations
- **Concurrency:** ETag/If-Match for critical updates
- **Pagination:** Cursor-based for large lists
- **Errors:** `{ code, message, field_errors[], request_id, retryable }`

### 5.2 Endpoint Groups

```
/api/v1/
├── auth/
│   ├── POST   /login                    # Authenticate
│   ├── POST   /refresh                  # Refresh token
│   ├── POST   /logout                   # Revoke session
│   ├── POST   /mfa/setup                # Enable MFA
│   └── POST   /mfa/verify               # Verify MFA code
│
├── employees/
│   ├── GET    /                         # List employees
│   ├── POST   /                         # Create employee
│   ├── GET    /:id                      # Get employee
│   ├── PATCH  /:id                      # Update employee
│   ├── POST   /:id/exit                 # Exit employee
│   ├── POST   /:id/reactivate           # Reactivate employee
│   ├── POST   /bulk-import              # Bulk import (staging)
│   ├── GET    /:id/documents            # List documents
│   └── POST   /:id/documents            # Upload document
│
├── attendance/
│   ├── POST   /events                   # Submit attendance event
│   ├── GET    /records                  # List attendance records
│   ├── GET    /records/:id              # Get attendance record
│   ├── POST   /exceptions               # Submit exception
│   ├── PATCH  /exceptions/:id/decision  # Approve/reject exception
│   └── POST   /regularize               # Request regularization
│
├── leave/
│   ├── POST   /requests                 # Submit leave request
│   ├── GET    /requests                 # List leave requests
│   ├── GET    /requests/:id             # Get leave request
│   ├── POST   /requests/:id/decision    # Approve/reject
│   ├── GET    /balances                 # Get leave balances
│   └── GET    /types                    # List leave types
│
├── payroll/
│   ├── POST   /runs                     # Create payroll run
│   ├── GET    /runs                     # List payroll runs
│   ├── GET    /runs/:id                 # Get payroll run
│   ├── POST   /runs/:id/calculate       # Calculate payroll
│   ├── POST   /runs/:id/approve         # Approve payroll
│   ├── POST   /runs/:id/lock            # Lock payroll
│   ├── GET    /runs/:id/payslips        # List payslips
│   └── GET    /runs/:id/payslips/:pid   # Get/download payslip
│
├── projects/
│   ├── POST   /                         # Create project
│   ├── GET    /                         # List projects
│   ├── GET    /:id                      # Get project
│   ├── PATCH  /:id                      # Update project
│   ├── POST   /:id/close                # Close project
│   ├── GET    /:id/tasks                # List project tasks
│   ├── GET    /:id/boards               # List project boards
│   └── GET    /:id/cycles               # List project cycles
│
├── tasks/
│   ├── POST   /                         # Create task (quick-add)
│   ├── GET    /                         # List tasks
│   ├── GET    /:id                      # Get task
│   ├── PATCH  /:id                      # Update task
│   ├── PATCH  /:id/status               # Transition status
│   ├── PATCH  /:id/board-position       # Reorder on board
│   ├── POST   /:id/assign               # Assign task
│   ├── POST   /:id/comments             # Add comment
│   ├── GET    /:id/comments             # List comments
│   ├── POST   /:id/evidence             # Upload evidence
│   ├── POST   /:id/dependencies         # Add dependency
│   └── DELETE /:id/dependencies/:depId   # Remove dependency
│
├── boards/
│   ├── POST   /                         # Create board view
│   ├── GET    /                         # List boards
│   ├── GET    /:id                      # Get board
│   ├── PATCH  /:id                      # Update board config
│   ├── GET    /:id/columns              # List columns
│   └── PATCH  /:id/columns              # Update columns
│
├── cycles/
│   ├── POST   /                         # Create cycle
│   ├── GET    /                         # List cycles
│   ├── GET    /:id                      # Get cycle
│   ├── POST   /:id/close                # Close cycle (trigger rollover)
│   └── GET    /:id/metrics              # Get velocity/burndown
│
├── inventory/
│   ├── POST   /transactions             # Post stock movement
│   ├── GET    /transactions             # List transactions
│   ├── GET    /items                    # List stock items
│   ├── POST   /items                    # Create stock item
│   └── GET    /alerts                   # Low stock alerts
│
├── assets/
│   ├── POST   /                         # Create asset
│   ├── GET    /                         # List assets
│   ├── GET    /:id                      # Get asset
│   ├── POST   /:id/assign               # Assign asset
│   ├── POST   /:id/return               # Return asset
│   ├── POST   /:id/audit                # QR audit scan
│   └── GET    /:id/assignments          # Assignment history
│
├── automation-rules/
│   ├── POST   /                         # Create rule
│   ├── GET    /                         # List rules
│   ├── GET    /:id                      # Get rule
│   ├── PATCH  /:id                      # Update rule
│   ├── GET    /:id/executions           # Execution history
│   └── POST   /:id/test                 # Test rule
│
├── dashboards/
│   ├── GET    /role/:role               # Role-specific dashboard
│   ├── GET    /my-work                  # My Work cross-project view
│   └── GET    /widgets/:widgetId        # Widget data
│
├── reports/
│   ├── POST   /generate                 # Generate report (async)
│   ├── GET    /:id                      # Get report status
│   └── GET    /:id/download             # Download report
│
├── notifications/
│   ├── GET    /                         # List notifications
│   ├── PATCH  /:id/read                 # Mark as read
│   └── POST   /read-all                 # Mark all as read
│
├── webhooks/
│   ├── POST   /                         # Register subscription
│   ├── GET    /                         # List subscriptions
│   ├── PATCH  /:id                      # Update subscription
│   └── DELETE /:id                      # Delete subscription
│
└── audit/
    └── GET    /                         # Search audit events
```

---

## 6. Security Architecture

### 6.1 Authentication Flow

```
┌──────────┐     POST /auth/login      ┌──────────────┐
│  Client  │ ──────────────────────────►│  Auth Module  │
│          │ ◄──────────────────────────│              │
│          │     { access_token,        │  • Validate  │
│          │       refresh_token }       │  • MFA check │
│          │                            │  • JWT sign  │
│          │     GET /api/v1/*           │              │
│          │     Authorization: Bearer   │              │
│          │ ──────────────────────────►│              │
│          │     200 OK                 │              │
└──────────┘                            └──────────────┘

Token lifecycle:
1. Login → short-lived access token (15min) + refresh token (7d)
2. Access token expires → use refresh token to get new pair
3. Refresh token expires → re-authenticate
4. Password/security change → revoke all sessions
5. Failed attempts → progressive lockout
```

### 6.2 Authorization Middleware

```
Request → JWT Verify → Extract user + roles + scopes
       → RBAC Check (permission × scope_type × scope_id)
       → Field-level masking (sensitive fields)
       → Route Handler
       → Audit Event (for mutations)
```

### 6.3 Data Protection

| Layer | Control |
|-------|---------|
| **Transit** | TLS 1.3, HSTS, secure cookies |
| **At Rest** | AES-256 encryption (PostgreSQL TDE or application-level) |
| **Application** | Field-level encryption for Aadhaar/PAN/bank |
| **UI** | Masked display (last 4 digits), field-level permissions |
| **Logs** | PII scrubbing, structured logging |
| **Object Storage** | Private buckets, signed URLs, access auditing |

---

## 7. Offline Sync Architecture (Android)

### 7.1 Sync State Machine

```
┌─────────┐    Server OK    ┌──────────┐
│ QUEUED   │ ──────────────►│  SYNCED  │
└─────────┘                 └──────────┘
      │                           ▲
      │ Queue locally             │ Retry on reconnect
      │                           │
      ▼                           │
┌──────────┐    Network OK   ┌──────────┐
│ SYNCING  │ ──────────────►│  SYNCED  │
└──────────┘                 └──────────┘
      │
      │ Validation error
      ▼
┌──────────┐
│ REJECTED │  → Show error, allow edit/resubmit
└──────────┘

      │ Conflict detected
      ▼
┌──────────┐
│ CONFLICT │  → Show both versions, manual resolution
└──────────┘
```

### 7.2 Sync Strategy

```kotlin
// Local Room DB schema mirrors server subset
@Entity(tableName = "pending_operations")
data class PendingOperation(
    @PrimaryKey val id: String,          // Client-generated UUID
    val entityType: String,
    val entityId: String,
    val operation: String,               // CREATE, UPDATE, DELETE
    val payload: String,                 // JSON
    val createdAt: Long,
    val retryCount: Int = 0,
    val status: String = "QUEUED"        // QUEUED, SYNCING, SYNCED, FAILED, CONFLICT
)

// Idempotency key = client operation ID
// Server returns:
//   ACCEPTED → mark SYNCED
//   ALREADY_APPLIED → mark SYNCED (idempotent)
//   REJECTED_VALIDATION → show error, mark FAILED
//   CONFLICT → show resolution UI
//   REQUIRES_REVIEW → queue for manual review
```

---

## 8. Background Job Architecture

### 8.1 Job Queue (BullMQ on Redis)

| Queue | Jobs | Schedule |
|-------|------|----------|
| **notifications** | Send push/SMS/email, in-app notification | Event-driven |
| **payroll** | Calculate payroll, generate payslips, statutory exports | Manual trigger + cron |
| **imports** | Bulk employee/master data import | Event-driven |
| **exports** | Report generation (Excel/PDF) | Event-driven |
| **automation** | Execute automation rules on domain events | Event-driven |
| **analytics** | Aggregate KPIs, update dashboards | Cron (hourly/daily) |
| **weather** | Fetch weather data for holiday decisions | Cron (daily) |
| **webhooks** | Deliver outbound webhook events | Event-driven |
| **ai** | Run prediction/anomaly models | Cron (daily) |
| **cleanup** | Archive old data, enforce retention | Cron (weekly) |

### 8.2 Domain Event Bus (In-Process)

```typescript
// Lightweight in-process event bus (no external broker for v1)
interface DomainEvent {
  type: string;           // e.g., 'task.status.changed'
  entityId: string;
  entityType: string;
  actorId: string;
  payload: Record<string, any>;
  timestamp: Date;
}

// Event emission
eventBus.emit('task.status.changed', {
  taskId: task.id,
  projectId: task.projectId,
  fromStatus: oldStatus,
  toStatus: newStatus,
  assigneeId: task.assigneeId,
});

// Event handlers (subscribed per module)
automationEngine.onTaskStatusChanged(event);
notificationModule.onTaskStatusChanged(event);
activityFeed.onTaskStatusChanged(event);
slaEngine.onTaskStatusChanged(event);
analyticsModule.onTaskStatusChanged(event);
```

---

## 9. Deployment Architecture

### 9.1 Environment Layout

```
┌─────────────────────────────────────────────────────────┐
│                    PRODUCTION                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  App Server  │  │  App Server  │  │  App Server  │ │
│  │  (AZ-1)     │  │  (AZ-1)     │  │  (AZ-2)     │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                 │                 │          │
│         └────────┬────────┴────────┬────────┘          │
│                  │                 │                    │
│                  ▼                 ▼                    │
│  ┌──────────────────────┐  ┌──────────────────┐       │
│  │  PostgreSQL Primary  │  │  Redis Cluster   │       │
│  │  (AZ-1)              │  │  (AZ-1 + AZ-2)  │       │
│  └──────────┬───────────┘  └──────────────────┘       │
│             │                                          │
│             ▼                                          │
│  ┌──────────────────────┐  ┌──────────────────┐       │
│  │  PostgreSQL Replica  │  │  S3 Object Store │       │
│  │  (AZ-2)              │  │  (Multi-AZ)      │       │
│  └──────────────────────┘  └──────────────────┘       │
│                                                         │
│  ┌──────────────────────┐  ┌──────────────────┐       │
│  │  Load Balancer       │  │  CDN              │       │
│  │  (ALB/CloudFlare)    │  │  (Static assets)  │       │
│  └──────────────────────┘  └──────────────────┘       │
│                                                         │
└─────────────────────────────────────────────────────────┘

RPO: ≤1 hour (recommended) | RTO: ≤2 hours (recommended)
```

### 9.2 Build Order (Per Requirements Section 26.1)

```
Phase 0: Foundation
  ├── Domain model (Section 6)
  ├── Permission matrix (Section 4)
  ├── Database migrations + seed data
  ├── Auth/MFA
  ├── Audit logging
  └── CI/CD pipeline

Phase 1: Core Workforce
  ├── Employee module
  ├── Document vault
  ├── Holidays
  ├── Leave module
  ├── Attendance module
  └── Android auth + profile

Phase 2: Field Operations & Work Management
  ├── Geo-fence module
  ├── Evidence capture
  ├── Offline sync (Android)
  ├── Projects module
  ├── Tasks module
  ├── Boards (List + Kanban)
  ├── SLA engine
  └── Escalation chains

Phase 3: Inventory & Payroll
  ├── Assets module
  ├── Inventory module
  ├── Vendors
  ├── Invoices
  ├── Payroll module
  └── Payslip generation

Phase 4: Automation & Analytics
  ├── Automation Engine
  ├── Calendar/Timeline views
  ├── Cycles/Sprints
  ├── Dashboards
  ├── Reports + exports
  ├── Webhooks
  ├── AI predictions
  └── Velocity/burndown

Phase 5: Hardening
  ├── Load testing (200+ concurrent)
  ├── Security testing
  ├── DR testing
  ├── Data migration
  ├── UAT
  └── Go-live
```

---

## 10. Project Structure

```
silverline-erp/
├── apps/
│   ├── api/                          # NestJS backend
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── common/               # Shared utilities
│   │   │   │   ├── guards/           # Auth, RBAC guards
│   │   │   │   ├── interceptors/     # Audit, idempotency
│   │   │   │   ├── filters/          # Error handling
│   │   │   │   ├── pipes/            # Validation
│   │   │   │   └── decorators/       # Custom decorators
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── employee/
│   │   │   │   ├── attendance/
│   │   │   │   ├── leave/
│   │   │   │   ├── payroll/
│   │   │   │   ├── geo-fence/
│   │   │   │   ├── projects/
│   │   │   │   ├── tasks/
│   │   │   │   ├── boards/
│   │   │   │   ├── cycles/
│   │   │   │   ├── inventory/
│   │   │   │   ├── assets/
│   │   │   │   ├── automation/
│   │   │   │   ├── analytics/
│   │   │   │   ├── notifications/
│   │   │   │   ├── webhooks/
│   │   │   │   ├── audit/
│   │   │   │   └── organization/
│   │   │   ├── database/
│   │   │   │   ├── migrations/
│   │   │   │   └── seeds/
│   │   │   └── config/
│   │   ├── test/
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── web/                          # Next.js frontend
│   │   ├── src/
│   │   │   ├── app/                  # App router pages
│   │   │   │   ├── (auth)/
│   │   │   │   ├── (dashboard)/
│   │   │   │   ├── employees/
│   │   │   │   ├── attendance/
│   │   │   │   ├── projects/
│   │   │   │   ├── inventory/
│   │   │   │   └── admin/
│   │   │   ├── components/
│   │   │   │   ├── ui/               # shadcn components
│   │   │   │   ├── board/            # Kanban board
│   │   │   │   ├── timeline/         # Gantt chart
│   │   │   │   ├── calendar/         # Calendar view
│   │   │   │   ├── dashboard/        # Dashboard widgets
│   │   │   │   └── shared/           # Shared components
│   │   │   ├── lib/
│   │   │   │   ├── api.ts            # API client
│   │   │   │   ├── auth.ts           # Auth helpers
│   │   │   │   └── utils.ts
│   │   │   └── hooks/
│   │   ├── public/
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── android/                      # Kotlin/Jetpack Compose
│       ├── app/
│       │   ├── src/main/java/.../
│       │   │   ├── di/               # Hilt modules
│       │   │   ├── data/
│       │   │   │   ├── local/        # Room DB
│       │   │   │   ├── remote/       # Retrofit API
│       │   │   │   ├── repository/
│       │   │   │   └── sync/         # Sync engine
│       │   │   ├── domain/
│       │   │   │   ├── model/
│       │   │   │   ├── repository/
│       │   │   │   └── usecase/
│       │   │   ├── ui/
│       │   │   │   ├── auth/
│       │   │   │   ├── attendance/
│       │   │   │   ├── tasks/
│       │   │   │   ├── assets/
│       │   │   │   ├── leave/
│       │   │   │   └── common/
│       │   │   └── SilverlineApp.kt
│       │   ├── src/main/res/
│       │   └── build.gradle.kts
│       ├── build.gradle.kts
│       └── settings.gradle.kts
│
├── packages/
│   ├── shared/                       # Shared types/interfaces
│   │   ├── src/
│   │   │   ├── types/                # TypeScript types
│   │   │   └── constants/
│   │   └── package.json
│   └── ui/                           # Shared UI primitives (optional)
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── DATABASE.md
│   ├── DEPLOYMENT.md
│   └── SECURITY.md
│
├── docker-compose.yml                # Local dev
├── docker-compose.prod.yml           # Production
├── turbo.json                        # Turborepo config
├── package.json
└── .github/
    └── workflows/
        ├── ci.yml
        ├── deploy-staging.yml
        └── deploy-prod.yml
```

---

## 11. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Monolith vs Microservices** | Modular monolith | Lightweight, simple deployment, domain boundaries allow future extraction |
| **Database** | PostgreSQL | JSONB for flexible fields, full-text search, row-level security, ACID |
| **ORM** | Prisma | Type-safe, migration support, good DX |
| **Web Framework** | NestJS | Modular, DI, guards, interceptors align with spec requirements |
| **Frontend** | Next.js + shadcn | SSR for dashboards, component library, accessible |
| **Android** | Kotlin + Compose | Official, performant, offline-first with Room |
| **Search** | PostgreSQL tsvector | Avoid Elasticsearch complexity for v1; upgrade path exists |
| **Queue** | BullMQ (Redis) | Simple, reliable, sufficient for v1 scale |
| **Event Bus** | In-process (NestJS EventEmitter) | No external broker needed for v1; upgrade path to Kafka |
| **Object Storage** | S3-compatible | Industry standard, encrypted, signed URLs |
| **Offline Sync** | Client-generated UUID + server idempotency | Deterministic, resumable, conflict-aware |

---

## 12. Scalability Considerations

### 12.1 Horizontal Scaling

- Stateless app servers behind load balancer
- Session data in Redis (not in-memory)
- PostgreSQL read replicas for analytics/reporting
- Object storage scales independently
- Worker processes scale independently

### 12.2 Performance Targets (From Spec)

| Metric | Target |
|--------|--------|
| Web page load | < 3 seconds |
| Android cold start | < 2 seconds |
| Board drag-drop feedback | < 100ms (optimistic UI) |
| Concurrent field users | 200+ |
| Availability | 99.5% monthly |

### 12.3 Caching Strategy

| Data | Cache Location | TTL | Invalidation |
|------|---------------|-----|--------------|
| User session | Redis | 15min (access), 7d (refresh) | On logout/password change |
| Role/permission | Redis | 5min | On role update |
| Village/location lists | Redis | 1 hour | On master data change |
| Workflow definitions | Redis | 5min | On workflow config change |
| Board configurations | Redis | 5min | On board update |
| Dashboard aggregations | Redis | 15min | On underlying data change |

---

## 13. Monitoring & Observability

```
┌─────────────────────────────────────────────────────────┐
│                    OBSERVABILITY STACK                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Logs        → Structured JSON (pino/winston)           │
│              → Centralized (CloudWatch/Loki/Datadog)    │
│              → Request ID correlation                   │
│              → PII scrubbed                             │
│                                                         │
│  Metrics     → Prometheus/Grafana                       │
│              → Request rate, latency, errors            │
│              → Job queue depth, processing time         │
│              → DB connection pool, query latency        │
│              → Sync queue depth (Android)               │
│                                                         │
│  Traces      → OpenTelemetry                            │
│              → Distributed tracing across modules       │
│              → External API call tracing                 │
│                                                         │
│  Audit       → Append-only audit_events table           │
│              → Every mutation recorded                  │
│              → Queryable by actor/entity/action         │
│                                                         │
│  Alerts      → PagerDuty/OpsGenie                      │
│              → SLA breach, error rate spikes            │
│              → Failed job thresholds                    │
│              → Security events                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

This architecture document provides a complete blueprint for building Silverline ERP v2.0. It follows the specification's principles: modular monolith, boring technology, API-first, offline-first for Android, server-authoritative, and configuration over code.