import { Link } from 'react-router-dom';

export function ForbiddenPage() {
  return (
    <section>
      <h1 style={{ fontSize: 22 }}>没有访问权限</h1>
      <p style={{ color: '#64748b' }}>
        页面导航和接口均按服务端权限校验；如职责已调整，请联系租户管理员更新角色。
      </p>
      <Link to="/">返回工作台</Link>
    </section>
  );
}
