// Agent 版本管理页：上传 exe / 切换 latest / 删除版本
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload';
import { ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  deleteAgentVersion,
  getAgentVersions,
  setLatestVersion,
  uploadAgentVersion,
  type AgentVersion,
} from '../api/admin';

export default function AgentVersions() {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [loading, setLoading] = useState(false);

  // 上传 Modal 状态
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [version, setVersion] = useState('');
  const [force, setForce] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  // 加载版本列表
  const loadVersions = async () => {
    setLoading(true);
    try {
      const data = await getAgentVersions();
      setVersions(data);
    } catch (err) {
      console.error('加载版本列表失败', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadVersions();
  }, []);

  // 重置上传表单
  const resetUploadForm = () => {
    setVersion('');
    setForce(false);
    setFile(null);
  };

  // 提交上传
  const handleUpload = async () => {
    if (!file) {
      message.warning('请选择要上传的 exe 文件');
      return;
    }
    if (!version.trim()) {
      message.warning('请输入版本号');
      return;
    }
    setUploading(true);
    try {
      await uploadAgentVersion(file, version.trim(), force);
      message.success('上传成功');
      setUploadOpen(false);
      resetUploadForm();
      loadVersions();
    } catch (err) {
      console.error('上传失败', err);
    } finally {
      setUploading(false);
    }
  };

  // 设为最新
  const handleSetLatest = async (id: number) => {
    try {
      await setLatestVersion(id);
      message.success('已设为最新版本');
      loadVersions();
    } catch (err) {
      console.error('设为最新失败', err);
    }
  };

  // 删除版本
  const handleDelete = async (id: number) => {
    try {
      await deleteAgentVersion(id);
      message.success('删除成功');
      loadVersions();
    } catch (err) {
      console.error('删除失败', err);
    }
  };

  // 表格列定义
  const columns = useMemo<ColumnsType<AgentVersion>>(
    () => [
      {
        title: '版本号',
        dataIndex: 'version',
        key: 'version',
      },
      {
        title: 'SHA256',
        dataIndex: 'sha256',
        key: 'sha256',
        render: (sha: string) =>
          sha ? `${sha.slice(0, 16)}...` : '-',
      },
      {
        title: '是否最新',
        dataIndex: 'is_latest',
        key: 'is_latest',
        render: (v: number) =>
          v === 1 ? <Tag color="green">最新</Tag> : <Tag>历史</Tag>,
      },
      {
        title: '强制升级',
        dataIndex: 'force',
        key: 'force',
        render: (v: number) =>
          v === 1 ? <Tag color="red">强制</Tag> : <Tag>否</Tag>,
      },
      {
        title: '上传时间',
        dataIndex: 'created_at',
        key: 'created_at',
        render: (v: string) =>
          v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-',
      },
      {
        title: '操作',
        key: 'action',
        render: (_, record) => (
          <Space size={0}>
            {record.is_latest !== 1 && (
              <Popconfirm
                title="确认设为最新版本？"
                onConfirm={() => handleSetLatest(record.id)}
                okText="确认"
                cancelText="取消"
              >
                <Button type="link">设为最新</Button>
              </Popconfirm>
            )}
            <Popconfirm
              title="确认删除该版本？"
              description="删除后不可恢复"
              onConfirm={() => handleDelete(record.id)}
              okText="确认"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button type="link" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [],
  );

  // Upload beforeUpload 拦截：返回 false 阻止自动上传，手动控制
  const beforeUpload = (f: File): boolean => {
    setFile(f);
    return false;
  };

  // 移除已选文件
  const handleRemoveFile = (): void => {
    setFile(null);
  };

  // 已选文件转 UploadFile 列表（受控模式）
  const fileList: UploadFile[] = file
    ? [
        {
          uid: '-1',
          name: file.name,
          status: 'done',
          size: file.size,
          type: file.type,
        },
      ]
    : [];

  return (
    <Card
      title="Agent 版本管理"
      extra={
        <Space>
          <Button
            icon={<UploadOutlined />}
            type="primary"
            onClick={() => setUploadOpen(true)}
          >
            上传新版本
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={loadVersions}
            loading={loading}
          >
            刷新
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={versions}
          pagination={{ pageSize: 10 }}
        />
      </Spin>

      {/* 上传 Modal */}
      <Modal
        title="上传 Agent 版本"
        open={uploadOpen}
        onOk={handleUpload}
        onCancel={() => {
          setUploadOpen(false);
          resetUploadForm();
        }}
        confirmLoading={uploading}
        okText="上传"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 8 }}>版本号：</div>
            <Input
              placeholder="例如：1.0.0"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 8 }}>Agent exe 文件：</div>
            <Upload
              beforeUpload={beforeUpload}
              onRemove={handleRemoveFile}
              fileList={fileList}
              maxCount={1}
              accept=".exe"
            >
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
          </div>
          <div>
            <Space>
              <span>强制升级：</span>
              <Switch
                checked={force}
                onChange={(checked) => setForce(checked)}
              />
              <span style={{ color: '#999', fontSize: 12 }}>
                开启后，已部署的 Agent 将被强制升级到此版本
              </span>
            </Space>
          </div>
        </Space>
      </Modal>
    </Card>
  );
}
