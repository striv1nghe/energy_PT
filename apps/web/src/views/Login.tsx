import { useState } from 'react';
import { Button, Card, Form, Input, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';

export default function Login() {
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        message.error(data?.message ?? '用户名或密码错误');
        return;
      }
      const data = (await res.json()) as { accessToken: string };
      localStorage.setItem('energy_token', data.accessToken);
      window.dispatchEvent(new Event('energy-auth-login'));
    } catch {
      message.error('登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(160deg, #063422 0%, #0b4930 45%, #f4f7f5 45.1%)',
        padding: 24,
      }}
    >
      <Card
        style={{ width: 380, borderRadius: 16, boxShadow: '0 20px 60px rgba(9, 71, 46, 0.25)' }}
        styles={{ body: { padding: '32px 32px 28px' } }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 40 }}>🌿</div>
          <div style={{ fontSize: 22, fontWeight: 750, color: '#0b4930' }}>绿城园区能源数据监控中心</div>
          <div style={{ fontSize: 13, color: '#7d968b', marginTop: 6 }}>请登录后访问园区能源监控看板</div>
        </div>

        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input size="large" prefix={<UserOutlined style={{ color: '#9fc4b1' }} />} placeholder="请输入用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password size="large" prefix={<LockOutlined style={{ color: '#9fc4b1' }} />} placeholder="请输入密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
            <Button type="primary" size="large" htmlType="submit" block loading={loading}>
              登 录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
