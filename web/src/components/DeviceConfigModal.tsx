// 设备配置远程控制 Modal：截图质量/宽度/采集频率/保存时间 + 显示器分辨率只读展示
import { useEffect, useState } from 'react';
import {
  Button,
  Form,
  InputNumber,
  Modal,
  Select,
  Slider,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  getDeviceConfig,
  updateDeviceConfig,
  type DeviceConfig,
} from '../api/admin';

const { Text } = Typography;

// 保存时间单位选项
const RETENTION_UNIT_OPTIONS = [
  { label: '时', value: 'hours' },
  { label: '天', value: 'days' },
  { label: '月', value: 'months' },
  { label: '年', value: 'years' },
];

interface DeviceConfigModalProps {
  deviceId: string;
  open: boolean;
  onClose: () => void;
}

export default function DeviceConfigModal({
  deviceId,
  open,
  onClose,
}: DeviceConfigModalProps) {
  const [form] = Form.useForm<DeviceConfig>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [monitorResolutions, setMonitorResolutions] = useState<
    { width: number; height: number }[]
  >([]);
  // 显示器最大宽度：作为截图最大宽度输入的上限
  const [maxMonitorWidth, setMaxMonitorWidth] = useState<number>(1920);

  // 打开时加载配置
  useEffect(() => {
    if (!open || !deviceId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const resp = await getDeviceConfig(deviceId);
        if (cancelled) return;
        setMonitorResolutions(resp.monitor_resolutions ?? []);
        const widths = (resp.monitor_resolutions ?? []).map((m) => m.width);
        const widthMax = widths.length > 0 ? Math.max(...widths) : 1920;
        setMaxMonitorWidth(widthMax);
        form.setFieldsValue(resp.config);
      } catch (err) {
        console.error('加载设备配置失败', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [open, deviceId, form]);

  // 保存配置
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await updateDeviceConfig(deviceId, {
        screenshot_quality: values.screenshot_quality,
        screenshot_max_width: values.screenshot_max_width,
        screenshot_interval_sec: values.screenshot_interval_sec,
        retention_value: values.retention_value,
        retention_unit: values.retention_unit,
      });
      message.success('设备配置已保存');
      onClose();
    } catch (err) {
      // 校验失败或请求失败，请求失败提示已由拦截器统一处理
      if (err && typeof err === 'object' && 'errorFields' in err) {
        return;
      }
      console.error('保存设备配置失败', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`设备配置：${deviceId}`}
      open={open}
      onCancel={onClose}
      width={560}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saving}
          onClick={handleSave}
        >
          保存
        </Button>,
      ]}
    >
      <Spin spinning={loading}>
        {/* 显示器分辨率信息（只读） */}
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">显示器分辨率：</Text>
          {monitorResolutions.length === 0 ? (
            <Text type="secondary">暂无数据</Text>
          ) : (
            <Space size={[8, 8]} wrap style={{ marginTop: 8 }}>
              {monitorResolutions.map((m, idx) => (
                <Tag color="geekblue" key={idx}>
                  显示器{idx + 1}: {m.width}×{m.height}
                </Tag>
              ))}
            </Space>
          )}
        </div>

        <Form
          form={form}
          layout="vertical"
          initialValues={{
            screenshot_quality: 80,
            screenshot_max_width: 1920,
            screenshot_interval_sec: 30,
            retention_value: 7,
            retention_unit: 'days',
          }}
        >
          <Form.Item
            label="截图清晰度"
            name="screenshot_quality"
            rules={[{ required: true, message: '请设置清晰度' }]}
          >
            <Slider
              min={1}
              max={100}
              marks={{ 1: '1', 50: '50', 100: '100' }}
            />
          </Form.Item>

          <Form.Item
            label={`截图最大宽度（不超过 ${maxMonitorWidth}px）`}
            name="screenshot_max_width"
            rules={[{ required: true, message: '请输入最大宽度' }]}
          >
            <InputNumber
              min={1}
              max={maxMonitorWidth}
              style={{ width: '100%' }}
              addonAfter="px"
            />
          </Form.Item>

          <Form.Item
            label="采集频率"
            name="screenshot_interval_sec"
            rules={[{ required: true, message: '请输入采集频率' }]}
          >
            <InputNumber
              min={5}
              style={{ width: '100%' }}
              addonAfter="秒"
            />
          </Form.Item>

          <Form.Item label="保存时间" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="retention_value"
                noStyle
                rules={[{ required: true, message: '请输入保存时间' }]}
              >
                <InputNumber min={1} style={{ width: '60%' }} />
              </Form.Item>
              <Form.Item
                name="retention_unit"
                noStyle
                rules={[{ required: true, message: '请选择单位' }]}
              >
                <Select
                  style={{ width: '40%' }}
                  options={RETENTION_UNIT_OPTIONS}
                />
              </Form.Item>
            </Space.Compact>
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
}
