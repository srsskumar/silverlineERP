/**
 * Attach an expense receipt from the camera (B-003).
 *
 * No gallery picker: neither expo-image-picker nor expo-document-picker is
 * in apps/mobile/package.json, and the brief says not to add a dependency
 * for this. expo-camera already is (src/device/camera.ts's evidence
 * pipeline uses it), so this reuses the same lazy CameraView/
 * useCameraPermissions wrappers to take a fresh photo — camera only, no
 * gallery, no PDF. Unlike task evidence, a receipt carries no watermark or
 * GPS and uploads straight to the API rather than through the offline sync
 * queue: an expense claim itself is already raised online-only on this
 * screen (postExpenseClaim), so a receipt follows the same model.
 */
import { useRef, useState } from 'react';
import { Modal, View } from 'react-native';
import { File } from 'expo-file-system';
import { CameraView, useCameraPermissions } from './camera';
import { postExpenseReceipt, type ExpenseReceipt } from '../api/endpoints';
import { checkReceiptFile } from '../expenseReceiptsFormat';
import { Banner, Button, Muted, Row } from '../ui/primitives';
import { space, useTheme } from '../theme';

function remove(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // OS cache cleanup remains available.
  }
}

export function ReceiptCapture({
  claimId, onClose, onSaved,
}: {
  claimId: string;
  onClose: () => void;
  onSaved: (receipt: ExpenseReceipt) => void;
}) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<import('expo-camera').CameraView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const capture = async () => {
    setBusy(true);
    setError('');
    let uri: string | null = null;
    try {
      const camera = cameraRef.current;
      if (!camera) throw new Error('Camera not ready');
      const photo = await camera.takePictureAsync({ quality: 0.7, base64: false, exif: false });
      if (!photo?.uri) throw new Error('Capture failed');
      uri = photo.uri;
      const fileName = `receipt-${Date.now()}.jpg`;
      const content_base64 = await new File(photo.uri).base64();
      const approxBytes = Math.floor((content_base64.length * 3) / 4);
      const check = checkReceiptFile(fileName, approxBytes);
      if (!check.ok) throw new Error(check.reason);
      const receipt = await postExpenseReceipt(claimId, { file_name: fileName, content_base64 });
      onSaved(receipt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not attach this receipt');
    } finally {
      if (uri) remove(uri);
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={busy ? () => {} : onClose}>
      <View style={{ flex: 1, backgroundColor: theme.canvas }}>
        <Row style={{
          justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md,
          borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.surface,
        }}
        >
          <Muted style={{ color: theme.text, fontWeight: '700' }}>Attach receipt</Muted>
          <Button title="Cancel" variant="ghost" icon="close-outline" disabled={busy} onPress={onClose} />
        </Row>
        <View style={{ flex: 1, padding: space.lg }}>
          {permission?.granted ? (
            <View style={{ flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' }}>
              <CameraView ref={cameraRef} facing="back" style={{ flex: 1 }} />
            </View>
          ) : (
            <Button title="Allow camera access" icon="lock-open-outline" onPress={() => void requestPermission()} />
          )}

          {permission?.granted ? (
            <Button
              title={busy ? 'Uploading…' : 'Capture and attach'}
              icon="camera-outline"
              loading={busy}
              disabled={busy}
              style={{ marginTop: space.md }}
              onPress={() => void capture()}
            />
          ) : null}

          {error ? <View style={{ marginTop: space.md }}><Banner tone="danger" icon="alert-circle-outline" title={error} /></View> : null}
        </View>
      </View>
    </Modal>
  );
}
