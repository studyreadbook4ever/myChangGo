package dev.presentation;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Platform-only fixture provider: the separate test APK process has no Kotlin runtime. */
public final class FixtureProvider extends ContentProvider {
    public static final String AUTHORITY = "dev.presentation.studio.test.fixtures";
    public static final String DEMO_NAME = "테스트 발표 자료.pdf";
    public static final Uri DEMO_URI = Uri.parse("content://" + AUTHORITY + "/demo.pdf");
    public static final Uri MALFORMED_URI = Uri.parse("content://" + AUTHORITY + "/malformed.pdf");
    public static final Uri UNSUPPORTED_URI = Uri.parse("content://" + AUTHORITY + "/not-a-pdf.pdf");

    @Override public boolean onCreate() { return true; }

    @Override public String getType(Uri uri) {
        fixture(uri);
        return "application/pdf";
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection,
                                  String[] selectionArgs, String sortOrder) {
        String[] entry = fixture(uri);
        String[] columns = projection != null ? projection
                : new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        final File file;
        try { file = cachedAsset(entry[0]); }
        catch (IOException failure) { throw new IllegalStateException("Cannot open fixture", failure); }
        MatrixCursor cursor = new MatrixCursor(columns);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = entry[1];
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Fixtures are read-only");
        try {
            return ParcelFileDescriptor.open(cachedAsset(fixture(uri)[0]), ParcelFileDescriptor.MODE_READ_ONLY);
        } catch (IOException failure) {
            FileNotFoundException wrapped = new FileNotFoundException("Cannot open fixture");
            wrapped.initCause(failure);
            throw wrapped;
        }
    }

    @Override public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Fixtures are read-only");
    }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Fixtures are read-only");
    }

    @Override public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Fixtures are read-only");
    }

    private String[] fixture(Uri uri) {
        if (!AUTHORITY.equals(uri.getAuthority()) || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("Unknown fixture URI");
        }
        String path = uri.getEncodedPath();
        if ("/demo.pdf".equals(path)) return new String[] { "demo.pdf", DEMO_NAME };
        if ("/malformed.pdf".equals(path)) return new String[] { "malformed.pdf", "손상된 문서.pdf" };
        if ("/not-a-pdf.pdf".equals(path)) return new String[] { "not-a-pdf.pdf", "PDF처럼 보이는 이름.pdf" };
        throw new IllegalArgumentException("Unknown fixture URI");
    }

    private synchronized File cachedAsset(String asset) throws IOException {
        if (getContext() == null) throw new IllegalStateException("Provider is not attached");
        File file = new File(getContext().getCacheDir(), "provider-fixture-" + asset);
        if (!file.exists()) {
            try (InputStream input = getContext().getAssets().open(asset);
                 FileOutputStream output = new FileOutputStream(file)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            } catch (IOException failure) {
                file.delete();
                throw failure;
            }
        }
        return file;
    }
}
