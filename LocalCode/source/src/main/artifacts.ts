import { clipboard, shell } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ArtifactPreviews, resolveArtifactPath } from '../core/artifacts';
import type { ArtifactAction, ArtifactInputKind } from '../shared/artifacts';

export class ArtifactController extends ArtifactPreviews {
  async action(projectPath: string, input: string, action: ArtifactAction, inputKind: ArtifactInputKind = 'path'): Promise<void> {
    const target = await resolveArtifactPath(projectPath, input, inputKind);
    switch (action) {
      case 'copy-path': clipboard.writeText(target.absolute); return;
      case 'reveal': shell.showItemInFolder(target.absolute); return;
      case 'open': {
        const info = await this.info(projectPath, target.relative);
        if (!info.canOpenExternally) throw new Error('此文件可能直接执行程序，请使用“选择其他应用打开”并选择编辑器。');
        const error = await shell.openPath(target.absolute);
        if (error) throw new Error(`无法打开文件：${error}`);
        return;
      }
      case 'choose-app': {
        if (process.platform !== 'win32') throw new Error('选择其他应用暂仅支持 Windows。');
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
        // Arguments remain separate; no shell, PowerShell interpolation or command text.
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, ['shell32.dll,OpenAs_RunDLL', target.absolute], { shell: false, windowsHide: true, stdio: 'ignore' });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      }
    }
  }
}
