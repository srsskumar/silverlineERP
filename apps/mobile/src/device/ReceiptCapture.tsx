/**
 * Attach an expense receipt: take a photo, choose one from the gallery, or
 * upload a PDF/image file (B-003, owner request 2026-09-24).
 *
 * Opens on an "Add receipt" chooser (camera / gallery / file); picking
 * "Take photo" drops into the same expo-camera flow this screen has always
 * used (src/device/camera.ts's lazy CameraView/useCameraPermissions
 * wrappers). Gallery and file each hand back a native-picker result that
 * goes through the same upload path: safeReceiptFileName() first (some
 * Android SAF providers return a full on-device path as the "name"),
 * then checkReceiptFile() against the picker-reported byte size — BEFORE
 * base64-reading the file, so a huge PDF or an uncompressed gallery photo
 * is rejected without ever asking the phone to base64-encode it — then the
 * upload itself. Every rejection, client-side or server (413/422
 * UNSAFE_FILE/TOO_MANY_RECEIPTS/etc.), renders through describeApiError so
 * the message is always the friendliest one available (field errors first,
 * then the server's own message, matching every other write screen).
 */
import { useRef, useState } from 'react';
import { Modal, View } from 'react-native';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { CameraView, useCameraPermissions } from './camera';
import { postExpenseReceipt, type ExpenseReceipt } from '../api/endpoints';
import { checkReceiptFile, safeReceiptFileName } from '../expenseReceiptsFormat';
import { describeApiError } from '../errorFormat';
import { Banner, Button, ListRow, Muted, Row } from '../ui/primitives';
import { space, useTheme } from '../theme';

function remove(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // OS cache cleanup remains available.
  }
}

type Mode = 'menu' | 'camera';

export function ReceiptCapture({
  claimId, onClose, onSaved,
}: {
  claimId: string;
  onClose: () => void;
  onSaved: (receipt: ExpenseReceipt) => void;
}) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cameraRef = useRef<import('expo-camera').CameraView | null>(null);

  /**
   * Shared by all three sources: validate what the picker/camera reported
   * (size first — before ever touching the file's bytes), then upload.
   */
  const finishUpload = async (uri: string, rawFileName: string, mimeType?: string | null) => {
    setBusy(true);
    setError('');
    try {
      const fileName = safeReceiptFileName(rawFileName);
      const bytes = new File(uri).size;
      const check = checkReceiptFile(fileName, bytes, mimeType);
      if (!check.ok) throw new Error(check.reason);
      const content_base64 = await new File(uri).base64();
      const receipt = await postExpenseReceipt(claimId, { file_name: fileName, content_base64 });
      onSaved(receipt);
    } catch (e) {
      setError(describeApiError(e, 'Could not attach this receipt'));
      setMode('menu');
    } finally {
      remove(uri);
      setBusy(false);
    }
  };

  const capture = async () => {
    const camera = cameraRef.current;
    if (!camera) {
      setError('Camera not ready');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const photo = await camera.takePictureAsync({ quality: 0.7, base64: false, exif: false });
      if (!photo?.uri) throw new Error('Capture failed');
      await finishUpload(photo.uri, `receipt-${Date.now()}.jpg`, 'image/jpeg');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not attach this receipt');
      setBusy(false);
    }
  };

  const pickFromGallery = async () => {
    setError('');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Allow photo library access to choose a receipt from your gallery.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsMultipleSelection: false,
      exif: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    // A fallback extension must agree with the reported mime type (when there
    // is one) — guessing ".jpg" for a PNG the picker didn't name would fail
    // checkReceiptFile's mime/extension agreement check.
    const fallbackExt = asset.mimeType === 'image/png' ? 'png' : 'jpg';
    await finishUpload(asset.uri, asset.fileName ?? `receipt-${Date.now()}.${fallbackExt}`, asset.mimeType);
  };

  const pickFile = async () => {
    setError('');
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/jpeg', 'image/png'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await finishUpload(asset.uri, asset.name, asset.mimeType);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={busy ? () => {} : onClose}>
      <View style={{ flex: 1, backgroundColor: theme.canvas }}>
        <Row style={{
          justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md,
          borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.surface,
        }}
        >
          <Muted style={{ color: theme.text, fontWeight: '700' }}>Add receipt</Muted>
          <Button title="Cancel" variant="ghost" icon="close-outline" disabled={busy} onPress={onClose} />
        </Row>
        <View style={{ flex: 1, padding: space.lg }}>
          {mode === 'menu' ? (
            <View>
              <ListRow
                icon="camera-outline"
                title="Take photo"
                onPress={busy ? undefined : () => { setError(''); setMode('camera'); }}
              />
              <ListRow
                icon="images-outline"
                title="Choose from gallery"
                onPress={busy ? undefined : () => void pickFromGallery()}
              />
              <ListRow
                icon="document-attach-outline"
                title="Upload PDF or file"
                onPress={busy ? undefined : () => void pickFile()}
                last
              />
            </View>
          ) : (
            <>
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
              <Button
                title="Back"
                variant="ghost"
                icon="arrow-back-outline"
                disabled={busy}
                style={{ marginTop: space.sm }}
                onPress={() => { setError(''); setMode('menu'); }}
              />
            </>
          )}

          {busy && mode === 'menu' ? <Muted style={{ marginTop: space.md }}>Uploading…</Muted> : null}
          {error ? <View style={{ marginTop: space.md }}><Banner tone="danger" icon="alert-circle-outline" title={error} /></View> : null}
        </View>
      </View>
    </Modal>
  );
}
