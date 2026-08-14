import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { OrgService, type DepartmentWithCount } from './org.service';

function mapDepartment(department: DepartmentWithCount) {
  return {
    department_id: department.id,
    name: department.name,
    parent_id: department.parentId ?? '',
    employee_count: department.employeeCount,
    created_at: department.createdAt.getTime(),
  };
}

/** gRPC-интерфейс справочника подразделений (libs/contracts/proto/hr.proto). */
@Controller()
export class OrgGrpcController {
  constructor(private readonly org: OrgService) {}

  @GrpcMethod('OrgService', 'ListDepartments')
  async listDepartments(data: { query?: string }) {
    const departments = await this.org.listDepartments(data.query || undefined);
    return { departments: departments.map(mapDepartment) };
  }

  @GrpcMethod('OrgService', 'GetDepartment')
  async getDepartment(data: { department_id: string }) {
    return mapDepartment(await this.org.getDepartment(data.department_id));
  }

  @GrpcMethod('OrgService', 'CreateDepartment')
  async createDepartment(data: { name: string; parent_id?: string }) {
    return mapDepartment(
      await this.org.createDepartment({ name: data.name, parentId: data.parent_id || undefined }),
    );
  }

  @GrpcMethod('OrgService', 'UpdateDepartment')
  async updateDepartment(data: {
    department_id: string;
    name?: string;
    parent_id?: string;
    detach_parent?: boolean;
  }) {
    return mapDepartment(
      await this.org.updateDepartment({
        departmentId: data.department_id,
        name: data.name || undefined,
        parentId: data.parent_id || undefined,
        detachParent: data.detach_parent ?? false,
      }),
    );
  }

  @GrpcMethod('OrgService', 'DeleteDepartment')
  async deleteDepartment(data: { department_id: string }) {
    await this.org.deleteDepartment(data.department_id);
    return {};
  }

  @GrpcMethod('OrgService', 'AssignEmployees')
  async assignEmployees(data: { department_id: string; employee_ids?: string[] }) {
    const moved = await this.org.assignEmployees(data.department_id, data.employee_ids ?? []);
    return { value: moved };
  }
}
